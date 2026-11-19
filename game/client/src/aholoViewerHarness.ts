// 官方 @manycore/aholo-viewer 接入验证页（/aholo-viewer.html）。
// 独立入口，不进入游戏主循环；用于对比 ruins.spz 在官方渲染器下的质量，
// 对照 Babylon GaussianSplattingMesh 的泛白问题（main.ts ENABLE_SPZ=false）。
// 操作：左键拖拽环视、滚轮缩放、右键拖拽平移。
// URL 参数：file(资产路径) up(aholo|opencv|opengl) cam=x,y,z look=x,y,z pack(compressed|super|raw)
import {
  createViewer,
  setViewerConfig,
  PerspectiveCamera,
  BackgroundMode,
  Vector3,
  Color,
  SplatLoader,
  SplatUtils,
  ToneMapping,
} from "@manycore/aholo-viewer";

const statusEl = document.getElementById("status") as HTMLElement;
const params = new URLSearchParams(location.search);
const fileParam = params.get("file") ?? "/assets/aholo/ruins.spz";
// worker 内 fetch 无 base URL，必须给绝对 URL
const file = new URL(fileParam, location.origin).href;
const pack =
  params.get("pack") === "super"
    ? SplatLoader.SplatPackType.SuperCompressed
    : params.get("pack") === "raw"
      ? SplatLoader.SplatPackType.Raw
      : SplatLoader.SplatPackType.Compressed;
const UPS: Record<string, Vector3> = {
  aholo: new Vector3(0, 0, 1), // Aholo 平台数据默认 +Z 上
  opencv: new Vector3(0, -1, 0),
  opengl: new Vector3(0, 1, 0),
};
const up = UPS[params.get("up") ?? "aholo"] ?? UPS.aholo;
const v3 = (s: string | null, fb: [number, number, number]) => {
  if (!s) return new Vector3(...fb);
  const [x, y, z] = s.split(",").map(Number);
  return new Vector3(x, y, z);
};
const camPos = v3(params.get("cam"), [0, -30, 0]);
const lookAt = v3(params.get("look"), [0, 0, 2]);

function setStatus(text: string) {
  statusEl.textContent = text;
  const w = window as unknown as { __av: Record<string, unknown> };
  w.__av = { ...(w.__av ?? {}), status: text, file, at: Date.now() };
}

async function main() {
  setStatus(`loading ${file}`);
  const container = document.getElementById("app") as HTMLElement;
  const viewer = createViewer("aholo-viewer-harness", container, {});
  const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
  (window as unknown as { __av: Record<string, unknown> }).__av = { viewer, camera };

  const type = SplatLoader.detectSplatFileType(file.split(".").pop() ?? "", new Uint8Array(4));
  const splatType = type ?? SplatLoader.SplatFileType.SPZ;
  const data = await SplatLoader.parseSplatData(splatType, file, pack);
  const splat = await SplatUtils.createSplat(data);

  camera.up.copy(up);
  camera.position.copy(camPos);
  camera.lookAt(lookAt);

  viewer.getScene().add(splat);
  viewer.setCamera(camera);
  setViewerConfig(viewer, {
    pipeline: {
      Background: {
        background: {
          active: BackgroundMode.BasicBackground,
          basic: { color: new Color(0.05, 0.05, 0.05) },
        },
        ground: { enabled: false },
      },
      Splatting: {
        enabled: true,
        composite: {
          enabled: true,
          highPrecisionEnabled: true,
          toneMapping: ToneMapping.Neutral,
          exposure: 1,
        },
      },
      TAA: { enabled: false },
    },
  });

  viewer.requestRenderHandler = function () {
    requestAnimationFrame(render);
  };
  let frames = 0;
  function render() {
    frames++;
    viewer.render();
  }
  // 本机锁屏/失焦时 rAF 会停摆（见 PROGRESS 2026-11-03 心跳教训）：同步先画一帧，再用心跳兜底
  render();
  setInterval(render, 500);

  const prefix = `ready ${file}`;
  setStatus(`${prefix}\n左键环视 · 滚轮缩放 · 右键平移`);
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    setStatus(`${prefix}\nfps ${Math.round((frames * 1000) / (now - last))}\n左键环视 · 滚轮缩放 · 右键平移`);
    frames = 0;
    last = now;
  }, 1000);

  // ---- 最小轨道相机（SDK 未内置控制器）：绕 lookAt 点旋转/缩放/平移，纯数学不经 SDK 向量 API ----
  type V = [number, number, number];
  const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: V): V => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Rodrigues 旋转
  const rotate = (v: V, axis: V, ang: number): V => {
    const c = Math.cos(ang), s = Math.sin(ang);
    const cr = cross(axis, v), d = dot(axis, v);
    return [
      v[0] * c + cr[0] * s + axis[0] * d * (1 - c),
      v[1] * c + cr[1] * s + axis[1] * d * (1 - c),
      v[2] * c + cr[2] * s + axis[2] * d * (1 - c),
    ];
  };
  const upV: V = [up.x, up.y, up.z];
  let target: V = [lookAt.x, lookAt.y, lookAt.z];
  let offset: V = sub([camPos.x, camPos.y, camPos.z], target);
  const apply = () => {
    camera.position.set(target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]);
    camera.lookAt(new Vector3(target[0], target[1], target[2]));
    render();
  };
  let dragging = 0; // 1 左键环视 2 右键平移
  let px = 0, py = 0;
  container.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.button !== 2) return;
    dragging = e.button === 0 ? 1 : 2;
    px = e.clientX; py = e.clientY;
    container.setPointerCapture(e.pointerId);
  });
  container.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dxr = e.clientX - px, dyr = e.clientY - py;
    const dx = dxr * 0.005, dy = dyr * 0.005;
    px = e.clientX; py = e.clientY;
    if (dragging === 1) {
      const next = rotate(rotate(offset, upV, -dx), norm(cross(upV, offset)), -dy);
      if (Math.abs(dot(norm(next), upV)) < 0.985) offset = next; // 限制 pitch 避免过极点翻转
    } else {
      // 抓取语义：场景跟手。拖 1 屏幕宽约平移 1.6 倍视距
      const right = norm(cross(upV, offset));
      const panK = Math.hypot(...offset) * 0.0016;
      const upScreen = norm(cross(offset, right));
      target = add(add(target, scale(right, -dxr * panK)), scale(upScreen, dyr * panK));
    }
    apply();
  });
  container.addEventListener("pointerup", () => (dragging = 0));
  container.addEventListener("contextmenu", (e) => e.preventDefault());
  container.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const k = Math.exp(e.deltaY * 0.0012);
      const len = Math.hypot(...offset);
      if (len * k > 0.5 && len * k < 800) offset = scale(offset, k);
      apply();
    },
    { passive: false },
  );
}

main().catch((e) => {
  console.error("[aholo-viewer] load error", e);
  setStatus(`ERROR ${String(e)}`);
});
