import { ArcRotateCamera, Color3, Color4, CubeTexture, DirectionalLight, Engine, GlowLayer, HemisphericLight, ImageProcessingConfiguration, Scene, SceneLoader, Vector3 } from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

const canvas=document.querySelector<HTMLCanvasElement>("canvas")!;
const engine=new Engine(canvas,true);
const status=document.querySelector<HTMLElement>("#status")!;
const select=document.querySelector<HTMLSelectElement>("#source")!;
let active:Scene|null=null;
const sources:Record<string,string>={fort:"pirate-fort.glb",festival:"festival.glb",cottage:"cottage.glb",kit:"megakit/Wall_Plaster_Door_Round.gltf"};
async function load(name:string) {
  active?.dispose(); active=null;
  const scene=new Scene(engine); active=scene;
  scene.clearColor=new Color4(.68,.78,.85,1);
  scene.imageProcessingConfiguration.toneMappingEnabled=true;
  scene.imageProcessingConfiguration.toneMappingType=ImageProcessingConfiguration.TONEMAPPING_ACES;
  try {
    const file=sources[name], split=file.lastIndexOf("/");
    await SceneLoader.AppendAsync("/reference-art/"+file.slice(0,split+1),file.slice(split+1),scene);
    const meshes=scene.meshes.filter(m=>m.getTotalVertices()>0&&!/collision|trigger|^sea$/i.test(m.name));
    for(const mesh of scene.meshes) if(/collision|trigger/i.test(mesh.name)) mesh.setEnabled(false);
    const bounds=meshes.map(m=>{m.computeWorldMatrix(true);return m.getBoundingInfo().boundingBox;});
    const min=new Vector3(Infinity,Infinity,Infinity),max=new Vector3(-Infinity,-Infinity,-Infinity);
    for(const b of bounds){min.minimizeInPlace(b.minimumWorld);max.maximizeInPlace(b.maximumWorld);}
    const center=min.add(max).scale(.5),radius=Vector3.Distance(min,max)*1.5;
    const camera=new ArcRotateCamera("reviewCamera",-Math.PI/2+.55,Math.PI/3,radius,center,scene);
    camera.minZ=.05;camera.maxZ=10000;camera.wheelDeltaPercentage=.01;camera.attachControl(canvas,true);scene.activeCamera=camera;
    const environment=CubeTexture.CreateFromPrefilteredData("/reference-art/environment.env",scene);
    scene.environmentTexture=environment;scene.environmentIntensity=name==="festival"?.2:.65;
    if(!scene.lights.length){const hemi=new HemisphericLight("referenceFill",Vector3.Up(),scene);hemi.intensity=.65;const sun=new DirectionalLight("referenceKey",new Vector3(-.6,-1,.5),scene);sun.intensity=1.5;sun.diffuse=new Color3(1,.94,.83);}
    if(name==="festival"){scene.clearColor=new Color4(.055,.075,.16,1);const glow=new GlowLayer("sourceGlow",scene);glow.intensity=.35;}
    await scene.whenReadyAsync(); engine.hideLoadingUI();
    status.textContent=`本地上游资产 · ${meshes.length}个可见网格 · 保留原几何/材质 · 拖动旋转，滚轮缩放`;
    (window as any).artReference={scene,camera,source:name,bounds:{min:min.asArray(),max:max.asArray()}};
  }catch(error){status.textContent=String(error);throw error;}
}
select.addEventListener("change",()=>void load(select.value));
engine.runRenderLoop(()=>active?.activeCamera&&active.render());
window.addEventListener("resize",()=>engine.resize());
void load(new URL(location.href).searchParams.get("source")||"fort");
