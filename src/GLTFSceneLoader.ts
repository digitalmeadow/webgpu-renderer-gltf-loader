import {
  WebIO,
  Document,
  Node as GLTFNode,
  Material as GLTFMaterial,
  Texture as GLTFTexture,
  Skin as GLTFSkin,
} from "@gltf-transform/core";
import {
  Renderer,
  Scene,
  Mesh,
  GroupEntity,
  Entity,
  EntityType,
  Geometry,
  Vertex,
  MaterialPBR,
  MaterialBasic,
  Texture,
  MaterialBase,
  AnimationClip,
  AnimationCurve,
  AnimationPath,
  AnimationInterpolation,
  Mat4,
  SkinData,
} from "@digitalmeadow/webgpu-renderer";

export type PreProcessNodeHook = (gltfNode: GLTFNode) => boolean;
export type ProcessNodeHook = (gltfNode: GLTFNode, entity: Entity) => boolean;

export class GLTFSceneLoader {
  private renderer: Renderer;
  public onPreProcessNode: PreProcessNodeHook | null = null;
  public onProcessNode: ProcessNodeHook | null = null;

  private parsedMaterials = new Map<GLTFMaterial, MaterialBase>();
  private parsedTextures = new Map<GLTFTexture, Texture>();
  private nodeToEntityMap = new Map<GLTFNode, Entity>();
  private parsedSkins = new Map<GLTFSkin, SkinData>();
  private nodeToJointIndex = new Map<GLTFNode, number>();

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  public async load(
    url: string,
    scene: Scene,
  ): Promise<{ clips: AnimationClip[] }> {
    const io = new WebIO();

    const document = await io.read(url);

    return await this.processDocument(document, scene);
  }

  public async loadFromBuffer(
    buffer: Uint8Array,
    scene: Scene,
  ): Promise<{ clips: AnimationClip[] }> {
    const io = new WebIO();
    const document = await io.readBinary(buffer);
    return await this.processDocument(document, scene);
  }

  private processDocument(
    document: Document,
    scene: Scene,
  ): Promise<{ clips: AnimationClip[] }> {
    this.nodeToEntityMap.clear();
    this.parsedSkins.clear();
    this.nodeToJointIndex.clear();

    const root = document.getRoot();
    const defaultScene = root.getDefaultScene() || root.listScenes()[0];

    if (!defaultScene) return Promise.resolve({ clips: [] });

    for (const gltfNode of defaultScene.listChildren()) {
      this.processNode(gltfNode, scene);
    }

    const clips = this.processAnimations(document);

    return Promise.resolve({ clips });
  }

  private processAnimations(document: Document): AnimationClip[] {
    const root = document.getRoot();
    const gltfAnimations = root.listAnimations();
    const clips: AnimationClip[] = [];

    for (const gltfAnim of gltfAnimations) {
      const clip = new AnimationClip(gltfAnim.getName() || "Animation");

      for (const channel of gltfAnim.listChannels()) {
        const targetNode = channel.getTargetNode();
        if (!targetNode) continue;

        const path = channel.getTargetPath();
        if (path !== "translation" && path !== "rotation" && path !== "scale") {
          continue;
        }

        const entity = this.nodeToEntityMap.get(targetNode);
        if (!entity) continue;

        const sampler = channel.getSampler();
        if (!sampler) continue;

        const inputAccessor = sampler.getInput();
        const outputAccessor = sampler.getOutput();
        if (!inputAccessor || !outputAccessor) continue;

        const timestamps = inputAccessor.getArray();
        const keyframes = outputAccessor.getArray();

        if (
          !timestamps ||
          !keyframes ||
          !(timestamps instanceof Float32Array) ||
          !(keyframes instanceof Float32Array)
        ) {
          continue;
        }

        let interpolation: AnimationInterpolation = "LINEAR";
        const samplerInterpolation = sampler.getInterpolation();
        if (samplerInterpolation === "STEP") {
          interpolation = "STEP";
        } else if (samplerInterpolation === "CUBICSPLINE") {
          interpolation = "LINEAR";
        }

        const curve = new AnimationCurve(
          entity.transform,
          path as AnimationPath,
          timestamps,
          keyframes,
          interpolation,
        );

        clip.addCurve(curve);
      }

      clips.push(clip);
    }

    return clips;
  }

  private processSkin(gltfSkin: GLTFSkin): SkinData {
    const skeleton = gltfSkin.getSkeleton();
    const joints = gltfSkin.listJoints();
    const jointEntities: Entity[] = [];
    const inverseBindMatrices: Mat4[] = [];

    const ibmAccessor = gltfSkin.getInverseBindMatrices();
    const ibmArray = ibmAccessor?.getArray() as Float32Array | null;

    for (let i = 0; i < joints.length; i++) {
      const jointNode = joints[i];

      let entity = this.nodeToEntityMap.get(jointNode);
      if (!entity) {
        const groupEntity = new GroupEntity(
          jointNode.getName() || `Joint_${i}`,
        );

        const position = jointNode.getTranslation();
        const rotation = jointNode.getRotation();
        const scale = jointNode.getScale();

        groupEntity.transform.setPosition(
          position[0],
          position[1],
          position[2],
        );
        groupEntity.transform.setRotationQuat(
          rotation[0],
          rotation[1],
          rotation[2],
          rotation[3],
        );
        groupEntity.transform.setScale(scale[0], scale[1], scale[2]);

        entity = groupEntity;
        this.nodeToEntityMap.set(jointNode, entity);
      }

      jointEntities.push(entity);
      this.nodeToJointIndex.set(jointNode, i);

      if (ibmArray) {
        const ibm = new Mat4();
        for (let j = 0; j < 16; j++) {
          ibm.data[j] = ibmArray[i * 16 + j];
        }
        inverseBindMatrices.push(ibm);
      } else {
        inverseBindMatrices.push(Mat4.identity());
      }
    }

    for (const jointNode of joints) {
      const parent = jointNode.getParentNode();
      if (parent && joints.includes(parent)) {
        const childEntity = this.nodeToEntityMap.get(jointNode);
        const parentEntity = this.nodeToEntityMap.get(parent);
        if (childEntity && parentEntity && childEntity !== parentEntity) {
          parentEntity.transform.addChild(childEntity.transform);
        }
      }
    }

    return new SkinData(jointEntities, inverseBindMatrices);
  }

  private processNode(gltfNode: GLTFNode, scene: Scene): Entity | null {
    const name = gltfNode.getName() || "Node";

    let rootEntity = this.nodeToEntityMap.get(gltfNode);
    const entitiesCreated: Entity[] = [];

    if (!rootEntity) {
      let shouldBuildGeometry = true;
      if (this.onPreProcessNode) {
        shouldBuildGeometry = this.onPreProcessNode(gltfNode);
      }

      const gltfMesh = shouldBuildGeometry ? gltfNode.getMesh() : null;

      if (gltfMesh) {
        const primitives = gltfMesh.listPrimitives();

        if (primitives.length === 1) {
          rootEntity = this.createMeshFromPrimitive(primitives[0], name);
          entitiesCreated.push(rootEntity);
        } else {
          const groupEntity = new GroupEntity(name);
          rootEntity = groupEntity;
          entitiesCreated.push(rootEntity);
          for (let i = 0; i < primitives.length; i++) {
            const primEntity = this.createMeshFromPrimitive(
              primitives[i],
              `${name}_prim${i}`,
            );
            entitiesCreated.push(primEntity);
            groupEntity.transform.addChild(primEntity.transform);
          }
        }
      } else {
        const groupEntity = new GroupEntity(name);
        rootEntity = groupEntity;
        entitiesCreated.push(rootEntity);
      }

      const position = gltfNode.getTranslation();
      const rotation = gltfNode.getRotation();
      const scale = gltfNode.getScale();

      rootEntity.transform.setPosition(position[0], position[1], position[2]);
      rootEntity.transform.setRotationQuat(
        rotation[0],
        rotation[1],
        rotation[2],
        rotation[3],
      );
      rootEntity.transform.setScale(scale[0], scale[1], scale[2]);

      this.nodeToEntityMap.set(gltfNode, rootEntity);
    }

    const gltfSkin = gltfNode.getSkin();
    if (gltfSkin && rootEntity.type === EntityType.Mesh) {
      let skinData = this.parsedSkins.get(gltfSkin);
      if (!skinData) {
        skinData = this.processSkin(gltfSkin);
        this.parsedSkins.set(gltfSkin, skinData);
      }
      (rootEntity as Mesh).skinData = skinData;
    }

    if (this.onProcessNode) {
      const shouldKeep = this.onProcessNode(gltfNode, rootEntity);
      if (!shouldKeep) {
        return null;
      }
    }

    for (const entity of entitiesCreated) {
      scene.add(entity);
    }

    for (const childNode of gltfNode.listChildren()) {
      const childEntity = this.processNode(childNode, scene);
      if (childEntity) {
        rootEntity.transform.addChild(childEntity.transform);
      }
    }

    return rootEntity;
  }

  private createMeshFromPrimitive(primitive: any, name: string): Mesh {
    const positionAccessor = primitive.getAttribute("POSITION");
    const normalAccessor = primitive.getAttribute("NORMAL");
    const uvAccessor = primitive.getAttribute("TEXCOORD_0");
    const jointsAccessor = primitive.getAttribute("JOINTS_0");
    const weightsAccessor = primitive.getAttribute("WEIGHTS_0");
    const indicesAccessor = primitive.getIndices();

    if (!positionAccessor) {
      throw new Error("Primitive missing POSITION attribute");
    }

    const count = positionAccessor.getCount();
    const vertices: Vertex[] = [];

    for (let i = 0; i < count; i++) {
      const pos = positionAccessor.getElement(i, []) as number[];
      const norm = normalAccessor
        ? (normalAccessor.getElement(i, []) as number[])
        : [0, 1, 0];
      const uv = uvAccessor
        ? (uvAccessor.getElement(i, []) as number[])
        : [0, 0];

      let jointIndices: [number, number, number, number] = [0, 0, 0, 0];
      let jointWeights: [number, number, number, number] = [0, 0, 0, 0];

      if (jointsAccessor && weightsAccessor) {
        const joints = jointsAccessor.getElement(i, []) as number[];
        const weights = weightsAccessor.getElement(i, []) as number[];

        jointIndices = [
          joints[0] || 0,
          joints[1] || 0,
          joints[2] || 0,
          joints[3] || 0,
        ];
        jointWeights = [
          weights[0] || 0,
          weights[1] || 0,
          weights[2] || 0,
          weights[3] || 0,
        ];
      }

      vertices.push(
        new Vertex(
          [pos[0], pos[1], pos[2], 1.0],
          [norm[0], norm[1], norm[2], 0.0],
          [uv[0], uv[1]],
          jointIndices,
          jointWeights,
        ),
      );
    }

    let indices: number[] = [];
    if (indicesAccessor) {
      const idxArray = indicesAccessor.getArray();
      if (idxArray) {
        indices = Array.from(idxArray);
      }
    } else {
      for (let i = 0; i < count; i++) {
        indices.push(i);
      }
    }

    const geometry = new Geometry(this.renderer.getDevice(), vertices, indices);

    const gltfMaterial = primitive.getMaterial();
    let material: MaterialBase;

    if (gltfMaterial) {
      material = this.processMaterial(gltfMaterial);
    } else {
      material = new MaterialBasic(
        this.renderer.getDevice(),
        `${name}_default_mat`,
      );
    }

    return new Mesh(this.renderer.getDevice(), name, geometry, material);
  }

  private processMaterial(gltfMaterial: GLTFMaterial): MaterialBase {
    if (this.parsedMaterials.has(gltfMaterial)) {
      return this.parsedMaterials.get(gltfMaterial)!;
    }

    const name = gltfMaterial.getName() || "GLTFMaterial";
    const baseColorTex = gltfMaterial.getBaseColorTexture();

    if (!baseColorTex) {
      const basic = new MaterialBasic(this.renderer.getDevice(), name, {
        color: gltfMaterial.getBaseColorFactor() as [
          number,
          number,
          number,
          number,
        ],
      });
      basic.doubleSided = gltfMaterial.getDoubleSided();
      const alphaMode = gltfMaterial.getAlphaMode();
      if (alphaMode === "OPAQUE") {
        basic.alphaMode = "opaque";
      } else if (alphaMode === "BLEND") {
        basic.alphaMode = "blend";
      } else if (alphaMode === "MASK") {
        basic.alphaMode = "mask";
      }
      basic.alphaCutoff = gltfMaterial.getAlphaCutoff();
      const baseColorFactor = gltfMaterial.getBaseColorFactor();
      if (baseColorFactor) {
        basic.opacity = baseColorFactor[3];
      }

      this.parsedMaterials.set(gltfMaterial, basic);
      return basic;
    }

    const pbr = new MaterialPBR(this.renderer.getDevice(), name);

    pbr.doubleSided = gltfMaterial.getDoubleSided();

    const alphaMode = gltfMaterial.getAlphaMode();
    if (alphaMode === "OPAQUE") {
      pbr.alphaMode = "opaque";
    } else if (alphaMode === "BLEND") {
      pbr.alphaMode = "blend";
    } else if (alphaMode === "MASK") {
      pbr.alphaMode = "mask";
    }

    pbr.alphaCutoff = gltfMaterial.getAlphaCutoff();

    const pbrBaseColorFactor = gltfMaterial.getBaseColorFactor();
    if (pbrBaseColorFactor) {
      pbr.opacity = pbrBaseColorFactor[3];
      pbr.baseColorFactor = pbrBaseColorFactor as [
        number,
        number,
        number,
        number,
      ];
    }

    if (baseColorTex) {
      pbr.albedoTexture = this.getTextureFromGLTFTexture(baseColorTex);
    }

    const normalTex = gltfMaterial.getNormalTexture();
    if (normalTex) {
      pbr.normalTexture = this.getTextureFromGLTFTexture(normalTex);
    }

    const metalRoughTex = gltfMaterial.getMetallicRoughnessTexture();
    if (metalRoughTex) {
      pbr.metalnessRoughnessTexture =
        this.getTextureFromGLTFTexture(metalRoughTex);
    }

    const emissiveTex = gltfMaterial.getEmissiveTexture();
    if (emissiveTex) {
      pbr.emissiveTexture = this.getTextureFromGLTFTexture(emissiveTex);
    }

    const emissiveFactor = gltfMaterial.getEmissiveFactor();
    if (emissiveFactor) {
      pbr.emissiveFactor = emissiveFactor as [number, number, number];
    }

    this.parsedMaterials.set(gltfMaterial, pbr);
    return pbr;
  }

  private getTextureFromGLTFTexture(gltfTexture: GLTFTexture): Texture {
    if (this.parsedTextures.has(gltfTexture)) {
      return this.parsedTextures.get(gltfTexture)!;
    }

    const mimeType = gltfTexture.getMimeType() || "image/png";
    const buffer = gltfTexture.getImage();

    if (!buffer) {
      throw new Error("GLTF texture is missing image data buffer");
    }

    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const texture = new Texture(url);
    texture.load();

    this.parsedTextures.set(gltfTexture, texture);
    return texture;
  }
}
