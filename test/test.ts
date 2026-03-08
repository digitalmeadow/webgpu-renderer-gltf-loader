import {
  Renderer,
  World,
  Scene,
  DirectionalLight,
  Camera,
  FlyControls,
  Time,
  Vec3,
} from "@digitalmeadow/webgpu-renderer";
import { GLTFSceneLoader } from "../src/index";

async function main() {
  const canvas = document.getElementById("gpu-canvas") as HTMLCanvasElement;
  if (!canvas) {
    console.error("Canvas not found");
    return;
  }

  const renderer = new Renderer(canvas);
  await renderer.init();

  const camera = new Camera(renderer.getDevice());
  camera.position.set(0, 1, 5);

  const controls = new FlyControls(canvas, camera);

  const world = new World();
  const scene = new Scene("MainScene");

  const light = new DirectionalLight("Sun");
  light.transform.setPosition(5, 10, 5);
  light.transform.lookAt(new Vec3(0, 0, 0));
  light.intensity = 1.0;
  scene.add(light);

  // We'd ideally load a real GLTF here.
  // We'll just verify the instantiation and hook setup for now.
  const loader = new GLTFSceneLoader(renderer);

  loader.onProcessNode = (gltfNode, entity) => {
    console.log(`Loaded node: ${gltfNode.getName()}`, entity);
    return true;
  };

  // To avoid needing a real .glb file inside this test, let's just
  // ensure everything compiles and runs to this point.
  await loader.load("/test/assets/gltf_test.gltf", scene);

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
