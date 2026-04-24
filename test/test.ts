import {
  Renderer,
  World,
  Scene,
  DirectionalLight,
  Camera,
  FlyControls,
  Time,
  Vec3,
  AnimationController,
  ConvexHull,
} from "@digitalmeadow/webgpu-renderer";
import {
  GLTFSceneLoader,
  getPrimitivePositions,
  getPrimitiveIndices,
} from "../src/index";

async function main() {
  const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
  if (!canvas) {
    console.error("Canvas not found");
    return;
  }

  const renderer = new Renderer(canvas);
  await renderer.init();

  const camera = new Camera(renderer.getDevice(), {
    aspect: canvas.clientWidth / canvas.clientHeight,
  });
  camera.transform.setPosition(0, 1, 5);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    renderer.resize(rect.width, rect.height);
    camera.resize(rect.width, rect.height);
  }

  window.addEventListener("resize", resize);
  resize();

  const controls = new FlyControls(canvas, camera);

  const world = new World();
  const scene = new Scene("MainScene");

  const light = new DirectionalLight("Sun");
  light.transform.setPosition(5, 10, 5);
  light.transform.lookAt(new Vec3(0, 0, 0));
  light.intensity = 1.0;
  scene.add(light);

  const loader = new GLTFSceneLoader(renderer);

  loader.onPreProcessNode = (gltfNode) => {
    // Check if the node has custom GLTF extras marking it as a physics body
    console.log("node: ", gltfNode);

    const extras = gltfNode.getExtras() as { isConvexHull?: boolean } | null;
    console.log("extras: ", extras);

    if (extras?.isConvexHull) {
      console.log(
        `[Physics] Extracting ConvexHull from node: ${gltfNode.getName()}`,
      );

      const mesh = gltfNode.getMesh();
      if (mesh) {
        for (const [index, primitive] of mesh.listPrimitives().entries()) {
          const positions = getPrimitivePositions(primitive);
          const indices = getPrimitiveIndices(primitive);

          const hull = new ConvexHull(positions, indices);
          console.log(`  Primitive ${index} -> ConvexHull`, {
            verticesCount: hull.vertexPositions.length / 3,
            trianglesCount: hull.vertexIndices.length / 3,
            hull,
          });
        }
      }

      // Return false to skip building visual WebGPU Meshes/Materials for this collider
      return false;
    }

    // Return true to process this node as a standard visual mesh
    return true;
  };

  loader.onProcessNode = (gltfNode, entity) => {
    console.log(`[Visual] Loaded node: ${gltfNode.getName()}`, entity);
    return true;
  };

  // To avoid needing a real .glb file inside this test, let's just
  // ensure everything compiles and runs to this point.
  const { clips } = await loader.load("/test/assets/gltf_test.gltf", scene);

  for (const clip of clips) {
    const controller = new AnimationController(clip);
    scene.animationManager.add(controller);
    controller.play(); // This will auto-play the animation continuously
  }

  world.addScene(scene);

  const time = new Time();

  function render() {
    time.update();
    controls.update(time.delta);
    renderer.render(world, camera, time);
    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);
}

main().catch(console.error);
