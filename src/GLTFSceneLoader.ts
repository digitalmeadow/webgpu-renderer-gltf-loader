import { WebIO, Document, Node as GLTFNode, Material as GLTFMaterial, Texture as GLTFTexture } from '@gltf-transform/core';
import { 
  Renderer, 
  Scene, 
  Entity, 
  Mesh, 
  Geometry, 
  Vertex, 
  MaterialPBR, 
  Texture,
  Vec3,
  Quat,
  MaterialBase
} from '@digitalmeadow/webgpu-renderer';

export class GroupEntity extends Entity {
  constructor(name: string = "Group") {
    super(name);
  }
}

export type ProcessNodeHook = (gltfNode: GLTFNode, entity: Entity) => boolean;

export class GLTFSceneLoader {
  private renderer: Renderer;
  public onProcessNode: ProcessNodeHook | null = null;
  
  private parsedMaterials = new Map<GLTFMaterial, MaterialBase>();
  private parsedTextures = new Map<GLTFTexture, Texture>();
  
  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }
  
  public async load(url: string, scene: Scene): Promise<void> {
    const io = new WebIO();
    
    // Fetch and load the document
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const document = await io.readBinary(new Uint8Array(arrayBuffer));
    
    await this.processDocument(document, scene);
  }

  public async loadFromBuffer(buffer: Uint8Array, scene: Scene): Promise<void> {
    const io = new WebIO();
    const document = await io.readBinary(buffer);
    await this.processDocument(document, scene);
  }

  private async processDocument(document: Document, scene: Scene): Promise<void> {
    const root = document.getRoot();
    const defaultScene = root.getDefaultScene() || root.listScenes()[0];
    
    if (!defaultScene) return;

    for (const gltfNode of defaultScene.listChildren()) {
      const entity = this.processNode(gltfNode);
      if (entity) {
        scene.add(entity);
      }
    }
  }

  private processNode(gltfNode: GLTFNode): Entity | null {
    const name = gltfNode.getName() || 'Node';
    
    // Create base entity for this node (Group or Mesh)
    const gltfMesh = gltfNode.getMesh();
    let rootEntity: Entity;
    
    if (gltfMesh) {
      const primitives = gltfMesh.listPrimitives();
      
      if (primitives.length === 1) {
        // Single primitive, we can just make this node a Mesh
        rootEntity = this.createMeshFromPrimitive(primitives[0], name);
      } else {
        // Multiple primitives, we need a Group entity with Mesh children
        rootEntity = new GroupEntity(name);
        for (let i = 0; i < primitives.length; i++) {
          const primEntity = this.createMeshFromPrimitive(primitives[i], `${name}_prim${i}`);
          rootEntity.transform.addChild(primEntity.transform);
        }
      }
    } else {
      rootEntity = new GroupEntity(name);
    }
    
    // Apply Transform
    const position = gltfNode.getTranslation();
    const rotation = gltfNode.getRotation();
    const scale = gltfNode.getScale();
    
    rootEntity.transform.setPosition(position[0], position[1], position[2]);
    rootEntity.transform.setRotationQuat(rotation[0], rotation[1], rotation[2], rotation[3]);
    rootEntity.transform.setScale(scale[0], scale[1], scale[2]);
    
    // Hook
    if (this.onProcessNode) {
      const shouldKeep = this.onProcessNode(gltfNode, rootEntity);
      if (!shouldKeep) {
        return null; // Consumer requested to discard this node
      }
    }
    
    // Process children
    for (const childNode of gltfNode.listChildren()) {
      const childEntity = this.processNode(childNode);
      if (childEntity) {
        rootEntity.transform.addChild(childEntity.transform);
      }
    }
    
    return rootEntity;
  }

  private createMeshFromPrimitive(primitive: any, name: string): Mesh {
    const positionAccessor = primitive.getAttribute('POSITION');
    const normalAccessor = primitive.getAttribute('NORMAL');
    const uvAccessor = primitive.getAttribute('TEXCOORD_0');
    const indicesAccessor = primitive.getIndices();
    
    if (!positionAccessor) {
      throw new Error("Primitive missing POSITION attribute");
    }
    
    const count = positionAccessor.getCount();
    const vertices: Vertex[] = [];
    
    for (let i = 0; i < count; i++) {
      const pos = positionAccessor.getElement(i, []) as number[];
      const norm = normalAccessor ? (normalAccessor.getElement(i, []) as number[]) : [0, 1, 0];
      const uv = uvAccessor ? (uvAccessor.getElement(i, []) as number[]) : [0, 0];
      
      vertices.push(
        new Vertex(
          [pos[0], pos[1], pos[2], 1.0], 
          [norm[0], norm[1], norm[2], 0.0], 
          [uv[0], uv[1]]
        )
      );
    }
    
    // Indices
    let indices: number[] = [];
    if (indicesAccessor) {
      const idxArray = indicesAccessor.getArray();
      if (idxArray) {
        indices = Array.from(idxArray);
      }
    } else {
      // Unindexed
      for (let i = 0; i < count; i++) {
        indices.push(i);
      }
    }
    
    const geometry = new Geometry(this.renderer.getDevice(), vertices, indices);
    
    // Material
    const gltfMaterial = primitive.getMaterial();
    let material: MaterialBase;
    
    if (gltfMaterial) {
      material = this.processMaterial(gltfMaterial);
    } else {
      material = new MaterialPBR(this.renderer.getDevice(), `${name}_default_mat`);
    }
    
    return new Mesh(this.renderer.getDevice(), name, geometry, material);
  }

  private processMaterial(gltfMaterial: GLTFMaterial): MaterialBase {
    if (this.parsedMaterials.has(gltfMaterial)) {
      return this.parsedMaterials.get(gltfMaterial)!;
    }
    
    const name = gltfMaterial.getName() || "GLTFMaterial";
    const pbr = new MaterialPBR(this.renderer.getDevice(), name);
    
    pbr.doubleSided = gltfMaterial.getDoubleSided();
    
    const alphaMode = gltfMaterial.getAlphaMode();
    if (alphaMode === 'OPAQUE') pbr.alphaMode = 'opaque';
    else if (alphaMode === 'BLEND') pbr.alphaMode = 'blend';
    else if (alphaMode === 'MASK') pbr.alphaMode = 'mask';
    
    pbr.alphaCutoff = gltfMaterial.getAlphaCutoff();
    
    // Textures
    const baseColorTex = gltfMaterial.getBaseColorTexture();
    if (baseColorTex) {
      pbr.albedoTexture = this.getTextureFromGLTFTexture(baseColorTex);
    }
    
    const normalTex = gltfMaterial.getNormalTexture();
    if (normalTex) {
      pbr.normalTexture = this.getTextureFromGLTFTexture(normalTex);
    }
    
    const metalRoughTex = gltfMaterial.getMetallicRoughnessTexture();
    if (metalRoughTex) {
      pbr.metalnessRoughnessTexture = this.getTextureFromGLTFTexture(metalRoughTex);
    }
    
    // Set colors - this would depend on how renderer accepts them, 
    // but material property mapping is base implementation here.
    
    this.parsedMaterials.set(gltfMaterial, pbr);
    return pbr;
  }

  private getTextureFromGLTFTexture(gltfTexture: GLTFTexture): Texture {
    if (this.parsedTextures.has(gltfTexture)) {
      return this.parsedTextures.get(gltfTexture)!;
    }

    const mimeType = gltfTexture.getMimeType() || 'image/png';
    const buffer = gltfTexture.getImage();
    
    // Fallback if image has no buffer, should not occur for regular valid GLTFs
    if (!buffer) {
      throw new Error('GLTF texture is missing image data buffer');
    }
    
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    
    const texture = new Texture(url);
    texture.load(); // Load asynchronously
    
    this.parsedTextures.set(gltfTexture, texture);
    return texture;
  }
}
