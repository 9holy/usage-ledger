import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  NoToneMapping,
  OrthographicCamera,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  WebGLRenderer,
} from "three";
import {
  buildCacheRibbonGeometry,
  type CacheRibbonGeometry,
  type Ribbon,
} from "./cacheRibbonGeometry";

export interface CacheRibbonMaterialRenderer {
  render(shape: CacheRibbonGeometry, width: number): string | null;
  dispose(): void;
}

// Project the reference material onto data-driven strips. Only green surface UVs
// are sampled: the reference's titles and numerical readouts are never rendered.
// Direction marks are removed from the material and drawn by the live SVG layer.
const materialSampling = `
vec4 ribbonAtlas(sampler2D atlas, vec2 uv) {
  vec2 p=vec2(uv.x*760.0,(1.0-uv.y)*285.0);
  vec4 rect=vec4(0.0); float slope=0.0;
  if(p.x>223.0&&p.x<251.0&&p.y>157.0&&p.y<184.0){rect=vec4(223.0,157.0,251.0,184.0);slope=.4;}
  else if(p.x>400.0&&p.x<432.0&&p.y>112.0&&p.y<144.0){rect=vec4(400.0,112.0,432.0,144.0);slope=-.7;}
  else if(p.x>590.0&&p.x<626.0&&p.y>112.0&&p.y<145.0){rect=vec4(590.0,112.0,626.0,145.0);slope=.45;}
  else if(p.x>193.0&&p.x<208.0&&p.y>83.0&&p.y<102.0){rect=vec4(193.0,83.0,208.0,102.0);slope=.16;}
  vec4 original=texture2D(atlas,uv);
  if(rect.z==0.0)return original;
  vec2 a=vec2(rect.x,p.y+slope*(rect.x-p.x));
  vec2 b=vec2(rect.z,p.y+slope*(rect.z-p.x));
  vec4 ca=texture2D(atlas,vec2(a.x/760.0,1.0-a.y/285.0));
  vec4 cb=texture2D(atlas,vec2(b.x/760.0,1.0-b.y/285.0));
  float edge=min(min(p.x-rect.x,rect.z-p.x),min(p.y-rect.y,rect.w-p.y));
  return mix(original,mix(ca,cb,(p.x-rect.x)/(rect.z-rect.x)),smoothstep(0.0,2.0,edge));
}`;

const points = (ribbon: Ribbon) => {
  const numbers = ribbon.body.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return Array.from({ length: numbers.length / 2 }, (_, i) => ({
    x: numbers[i * 2],
    y: numbers[i * 2 + 1],
  }));
};

export function cacheMaterialBand(
  target: Ribbon[],
  source: Ribbon[],
  scale = 1,
) {
  const top = points(target[0]),
    bottom = points(target[target.length - 1]);
  const sourceTop = points(source[0]),
    sourceBottom = points(source[source.length - 1]);
  const count = top.length / 2,
    positions: number[] = [],
    uvs: number[] = [],
    indices: number[] = [];
  // One continuous material field avoids seams when a small panel changes detail density.
  for (let i = 0; i < count; i++) {
    const ends = [top[i], bottom[bottom.length - 1 - i]];
    const reference = [sourceTop[i], sourceBottom[sourceBottom.length - 1 - i]];
    for (let side = 0; side < 2; side++) {
      const padding = side === 0 ? -1.4 : 1.4;
      positions.push(ends[side].x, -(ends[side].y + padding * scale), 0);
      uvs.push(
        reference[side].x / 760,
        1 - (reference[side].y + padding) / 285,
      );
    }
    if (i < count - 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  return { positions, uvs, indices };
}

export async function createCacheRibbonMaterial(
  url: string,
): Promise<CacheRibbonMaterialRenderer | null> {
  if (typeof WebGL2RenderingContext === "undefined") return null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!context) return null;
  const renderer = new WebGLRenderer({
    canvas,
    context,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.setClearColor(0, 0);
  let texture;
  try {
    texture = await new TextureLoader().loadAsync(url);
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  const material = new MeshBasicMaterial({
    map: texture,
    side: DoubleSide,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + materialSampling)
      .replace(
        "#include <map_fragment>",
        "diffuseColor *= ribbonAtlas(map,vMapUv);",
      );
  };
  const camera = new OrthographicCamera(-380, 380, 135.5, -135.5, 1, 2000);
  camera.position.set(380, -144.5, 1000);
  camera.lookAt(380, -144.5, 0);
  const scene = new Scene(),
    reference = buildCacheRibbonGeometry(0.975, 760);
  let disposed = false;
  let surfaceShape = reference;
  const clear = () => {
    for (const object of [...scene.children]) {
      const mesh = object as Mesh<BufferGeometry, MeshBasicMaterial>;
      mesh.geometry.dispose();
      scene.remove(mesh);
    }
  };
  return {
    render(shape, width) {
      if (disposed || context.isContextLost()) return null;
      clear();
      if (!shape.front.length) return null;
      if (surfaceShape.hitShare !== shape.hitShare)
        surfaceShape = buildCacheRibbonGeometry(shape.hitShare, 760);
      let order = 0;
      for (const kind of ["rear", "front"] as const) {
        const strip = cacheMaterialBand(
          surfaceShape[kind],
          reference[kind],
          Math.sqrt((shape.hitShare ?? 0) / 0.975),
        );
        const geometry = new BufferGeometry();
        geometry.setAttribute(
          "position",
          new Float32BufferAttribute(strip.positions, 3),
        );
        geometry.setAttribute("uv", new Float32BufferAttribute(strip.uvs, 2));
        geometry.setIndex(strip.indices);
        const mesh = new Mesh(geometry, material);
        mesh.renderOrder = order++;
        scene.add(mesh);
      }
      renderer.setPixelRatio(
        Math.min(3, Math.max(2, window.devicePixelRatio || 1)),
      );
      renderer.setSize(
        Math.max(1, Math.round(width)),
        Math.max(1, Math.round((width * 271) / 760)),
        false,
      );
      renderer.render(scene, camera);
      return canvas.toDataURL("image/png");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
