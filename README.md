# @digitalmeadow/webgpu-renderer-gltf-loader

Minimal glTF loader for the WebGPU renderer.

## Installation

```bash
npm install @digitalmeadow/webgpu-renderer-gltf-loader
```

## Features

- Dependency-free
- Custom parsing for glTF extras

## Usage

```typescript
import { GLTFSceneLoader } from "@digitalmeadow/webgpu-renderer-gltf-loader";

const loader = new GLTFSceneLoader();

async function loadScene() {
  const gltfScene = await loader.load("model.gltf");
  
  // Example: traversing nodes to read custom glTF extras
  gltfScene.traverse((node) => {
    if (node.extras && node.extras.isPhysicsBody) {
      console.log(`Node ${node.name} is a physics body with mass: ${node.extras.mass}`);
    }
    
    // Process your custom scene logic here
  });
  
  return gltfScene;
}

loadScene();
```