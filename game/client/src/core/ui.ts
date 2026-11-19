// DOM 界面层：HUD、对话框、面板、标题屏。
import { Vector3, Scene, Camera, Matrix } from "@babylonjs/core";
import { BUILD_CATALOG, ITEMS, ItemId, ItemStack } from "shared";

export interface UIBars { hp: number; maxHp: number; hunger: number; stamina: number; maxStamina: number; energy: number; showEnergy: boolean }

export class Hud {
  root: HTMLDivElement;
  private bars!: HTMLDivElement;
  private hpFill!: HTMLDivElement;
  private hungerFill!: HTMLDivElement;
  private stamFill!: HTMLDivElement;
  private energyRow!: HTMLDivElement;
  private energyFill!: HTMLDivElement;
  private promptEl!: HTMLDivElement;
  private toastEl!: HTMLDivElement;
  private questEl!: HTMLDivElement;
  private compassEl!: HTMLDivElement;
  private dialogEl!: HTMLDivElement;
  private dialogName!: HTMLDivElement;
  private dialogText!: HTMLDivElement;
  private dialogOptions!: HTMLDivElement;
  private dialogInput!: HTMLInputElement;
  private bubbleLayer!: HTMLDivElement;
  private panelEl!: HTMLDivElement;
  private panelTitle!: HTMLDivElement;
  panelBody!: HTMLDivElement;
  private perfEl!: HTMLDivElement;
  private buildHintEl!: HTMLDivElement;
  private titleEl: HTMLDivElement | null = null;
  private wsIndicator!: HTMLDivElement;
  onOption?: (i: number) => void;
  onChatSubmit?: (text: string) => void;
  onBuildSelect?: (partId: string) => void;
  onPanelClosed?: () => void;
  /** 面板打开时吞输入 */
  uiCapture = false;

  constructor(private container: HTMLElement) {
    this.root = document.createElement("div");
    this.root.id = "hud";
    this.root.style.cssText = `
      position: fixed; inset: 0; pointer-events: none; z-index: 10;
      font-family: "Microsoft YaHei", system-ui, sans-serif; color: #eef3f6;
      user-select: none;`;
    container.appendChild(this.root);
    this.buildStatic();
  }

  private el(html: string, css: string, parent?: HTMLElement): HTMLDivElement {
    const d = document.createElement("div");
    d.innerHTML = html;
    d.style.cssText = css;
    (parent ?? this.root).appendChild(d);
    return d;
  }

  private buildStatic() {
    // 状态条
    this.bars = this.el("", `position:absolute; left:18px; bottom:18px; width:230px; display:flex; flex-direction:column; gap:6px;`);
    const bar = (id: string, color: string, label: string) => {
      const row = this.el("", `display:flex; align-items:center; gap:6px;`, this.bars);
      this.el(`${label}`, `width:34px; font-size:12px; opacity:.85; text-shadow:0 1px 2px #000;`, row);
      const track = this.el("", `flex:1; height:10px; background:rgba(10,18,28,.62); border-radius:6px; overflow:hidden; border:1px solid rgba(255,255,255,.18);`, row);
      const fill = this.el("", `height:100%; width:100%; background:${color}; border-radius:6px; transition:width .2s;`, track);
      fill.id = id;
      return fill;
    };
    this.hpFill = bar("barHp", "linear-gradient(90deg,#e2574c,#f08a7e)", "生命");
    this.hungerFill = bar("barHunger", "linear-gradient(90deg,#d99a3d,#eec27a)", "饱食");
    this.stamFill = bar("barStam", "linear-gradient(90deg,#4ca86a,#8fd0a0)", "体力");
    this.energyRow = this.el("", `display:flex; align-items:center; gap:6px; display:none;`, this.bars);
    this.el(`风能`, `width:34px; font-size:12px; opacity:.85; text-shadow:0 1px 2px #000;`, this.energyRow);
    const etrack = this.el("", `flex:1; height:10px; background:rgba(10,18,28,.62); border-radius:6px; overflow:hidden; border:1px solid rgba(255,255,255,.18);`, this.energyRow);
    this.energyFill = this.el("", `height:100%; width:100%; background:linear-gradient(90deg,#4a8fb8,#8fd8ef); border-radius:6px; transition:width .2s;`, etrack);

    // 罗盘
    this.compassEl = this.el("", `position:absolute; top:12px; left:50%; transform:translateX(-50%); width:420px; height:30px;
      background:rgba(10,18,28,.55); border:1px solid rgba(255,255,255,.15); border-radius:8px; overflow:hidden;`);

    // 任务追踪
    this.questEl = this.el("", `position:absolute; top:12px; right:16px; width:250px; text-align:right; font-size:13px;
      text-shadow:0 1px 3px rgba(0,0,0,.8); line-height:1.5;`);

    // 交互提示
    this.promptEl = this.el("", `position:absolute; bottom:26%; left:50%; transform:translateX(-50%); padding:6px 14px;
      background:rgba(10,18,28,.7); border:1px solid rgba(255,255,255,.25); border-radius:8px; font-size:14px; display:none;
      text-shadow:0 1px 2px #000; white-space:nowrap;`);

    // 建造模式提示
    this.buildHintEl = this.el("", `position:absolute; bottom:20%; left:50%; transform:translateX(-50%); font-size:13px;
      text-shadow:0 1px 3px #000; display:none; opacity:.92; text-align:center;`);

    // toast
    this.toastEl = this.el("", `position:absolute; top:70px; left:50%; transform:translateX(-50%); padding:8px 18px;
      background:rgba(20,30,44,.85); border:1px solid rgba(255,255,255,.2); border-radius:8px; font-size:14px;
      opacity:0; transition:opacity .3s; max-width:60%; text-align:center;`);

    // WS 状态
    this.wsIndicator = this.el("NPC·本地", `display:none; position:absolute; top:12px; left:16px; font-size:12px; padding:3px 10px;
      background:rgba(10,18,28,.6); border:1px solid rgba(255,255,255,.18); border-radius:6px; opacity:.85;`);

    // 气泡层
    this.bubbleLayer = this.el("", `position:absolute; inset:0; overflow:hidden;`);
    // 对话框
    this.dialogEl = this.el("", `position:absolute; bottom:60px; left:50%; transform:translateX(-50%); width:640px; max-width:92vw;
      background:linear-gradient(180deg, rgba(16,26,38,.94), rgba(12,20,30,.94));
      border:1px solid rgba(255,255,255,.22); border-radius:12px; padding:14px 18px; display:none;
      pointer-events:auto; box-shadow:0 8px 32px rgba(0,0,0,.4);`);
    this.dialogName = this.el("", `font-size:14px; color:#f0c878; font-weight:600; margin-bottom:6px;`, this.dialogEl);
    this.dialogText = this.el("", `font-size:15px; line-height:1.7; min-height:44px; white-space:pre-wrap;`, this.dialogEl);
    this.dialogOptions = this.el("", `display:flex; flex-direction:column; gap:6px; margin-top:10px;`, this.dialogEl);
    const inputRow = this.el("", `display:flex; gap:8px; margin-top:8px;`, this.dialogEl);
    this.dialogInput = document.createElement("input");
    this.dialogInput.placeholder = "输入想说的…（回车发送）";
    this.dialogInput.style.cssText = `flex:1; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.2);
      border-radius:6px; padding:6px 10px; color:#fff; font-size:14px; outline:none;`;
    inputRow.appendChild(this.dialogInput);
    const sendBtn = document.createElement("button");
    sendBtn.textContent = "发送";
    sendBtn.style.cssText = `background:#3d6e8f; color:#fff; border:none; border-radius:6px; padding:6px 16px; cursor:pointer; font-size:14px;`;
    sendBtn.onclick = () => this.submitChat();
    inputRow.appendChild(sendBtn);
    this.dialogInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") this.submitChat();
      if (e.key === "Escape") this.hideDialog();
    });
    this.dialogInput.maxLength = 600;

    // 通用面板
    this.panelEl = this.el("", `position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); width:620px; max-width:94vw;
      max-height:76vh; overflow:auto; background:linear-gradient(180deg, rgba(16,26,38,.96), rgba(12,20,30,.96));
      border:1px solid rgba(255,255,255,.22); border-radius:12px; padding:16px 20px; display:none;
      pointer-events:auto; box-shadow:0 8px 32px rgba(0,0,0,.4);`);
    this.panelTitle = this.el("", `font-size:16px; color:#f0c878; font-weight:600; margin-bottom:10px; display:flex; justify-content:space-between;`, this.panelEl);
    this.panelBody = this.el("", ``, this.panelEl);

    // 性能面板
    this.perfEl = this.el("", `position:absolute; bottom:18px; right:16px; font-size:11px; line-height:1.5; opacity:0;
      background:rgba(10,18,28,.65); padding:8px 10px; border-radius:8px; border:1px solid rgba(255,255,255,.12);
      font-variant-numeric: tabular-nums; text-align:right;`);

    // 屏幕边缘指示
    this.el("◆", `display:none; position:absolute; font-size:20px; color:#f0c878; text-shadow:0 1px 3px #000;`).id = "edgeArrow";
  }

  private submitChat() {
    const v = this.dialogInput.value.trim();
    if (!v) return;
    this.dialogInput.value = "";
    this.onChatSubmit?.(v);
  }

  setBars(b: UIBars) {
    (this.hpFill as HTMLDivElement).style.width = `${Math.max(0, Math.min(100, (b.hp / b.maxHp) * 100))}%`;
    this.hungerFill.style.width = `${b.hunger}%`;
    this.stamFill.style.width = `${Math.min(100, (b.stamina / b.maxStamina) * 100)}%`;
    this.energyRow.style.display = b.showEnergy ? "flex" : "none";
    if (b.showEnergy) this.energyFill.style.width = `${b.energy}%`;
  }

  setPrompt(text: string | null) {
    if (text) { this.promptEl.textContent = text; this.promptEl.style.display = "block"; }
    else this.promptEl.style.display = "none";
  }

  setBuildHint(text: string | null) {
    if (text) { this.buildHintEl.innerHTML = text; this.buildHintEl.style.display = "block"; }
    else this.buildHintEl.style.display = "none";
  }

  toast(text: string, seconds = 3) {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = "1";
    clearTimeout((this as unknown as { _tt?: number })._tt);
    (this as unknown as { _tt?: number })._tt = window.setTimeout(() => (this.toastEl.style.opacity = "0"), seconds * 1000);
  }

  /** 受击红闪 */
  flashDamage() {
    let el = this.root.querySelector<HTMLDivElement>("#dmgFlash");
    if (!el) {
      el = document.createElement("div");
      el.id = "dmgFlash";
      el.style.cssText = `position:absolute; inset:0; pointer-events:none;
        box-shadow: inset 0 0 120px rgba(200,40,30,.75); opacity:0; transition:opacity .35s;`;
      this.root.appendChild(el);
    }
    el.style.opacity = "1";
    setTimeout(() => (el!.style.opacity = "0"), 160);
  }

  setQuest(html: string) { this.questEl.innerHTML = html; }

  setCompass(html: string) { this.compassEl.innerHTML = html; }

  setWs(text: string, llm: boolean) {
    this.wsIndicator.textContent = text;
    this.wsIndicator.style.borderColor = llm ? "rgba(120,220,160,.7)" : "rgba(255,255,255,.18)";
  }

  // ---- 对话 ----
  showDialog(name: string, text: string, options: string[]) {
    this.dialogEl.style.display = "block";
    this.dialogName.textContent = name;
    this.dialogText.textContent = text;
    this.dialogOptions.innerHTML = "";
    options.forEach((o, i) => {
      const b = document.createElement("button");
      b.textContent = o;
      b.style.cssText = `text-align:left; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.18);
        border-radius:6px; padding:7px 12px; color:#dfe8ee; cursor:pointer; font-size:14px;`;
      b.onmouseenter = () => (b.style.background = "rgba(255,255,255,.16)");
      b.onmouseleave = () => (b.style.background = "rgba(255,255,255,.07)");
      b.onclick = () => this.onOption?.(i);
      this.dialogOptions.appendChild(b);
    });
    this.uiCapture = true;
  }

  updateDialogText(text: string) { this.dialogText.textContent = text; }

  hideDialog() {
    this.dialogEl.style.display = "none";
    this.uiCapture = false;
    this.onPanelClosed?.();
  }

  dialogVisible() { return this.dialogEl.style.display !== "none"; }

  // ---- 面板 ----
  showPanel(title: string, bodyHtml: string, onClose?: () => void) {
    this.panelEl.style.display = "block";
    this.panelTitle.innerHTML = `${title}<span style="cursor:pointer; opacity:.7; font-size:12px;" id="panelClose">[关闭 Esc]</span>`;
    this.panelBody.innerHTML = bodyHtml;
    this.panelEl.querySelector("#panelClose")!.addEventListener("click", () => this.hidePanel());
    this.uiCapture = true;
    this.panelOnClose = onClose;
  }
  private panelOnClose?: () => void;

  hidePanel() {
    this.panelEl.style.display = "none";
    this.uiCapture = false;
    this.panelOnClose?.();
  }

  panelVisible() { return this.panelEl.style.display !== "none"; }

  showBuildPanel(current: string | null, canAfford: (cost: Partial<Record<ItemId, number>>) => boolean) {
    const groups: Record<string, string> = { structure: "结构", furniture: "家具", deco: "装饰", facility: "设施" };
    let html = `<div style="display:grid; grid-template-columns:repeat(2,1fr); gap:8px;">`;
    for (const part of BUILD_CATALOG) {
      const cost = Object.entries(part.cost).filter(([, n]) => n).map(([id, n]) => `${ITEMS[id as ItemId].name}×${n}`).join(" ") || "免费";
      const ok = canAfford(part.cost) && current !== part.id;
      html += `<div class="buildOpt" data-part="${part.id}" style="border:1px solid rgba(255,255,255,.15); border-radius:8px; padding:8px 10px;
        cursor:${ok ? "pointer" : "not-allowed"}; opacity:${ok ? 1 : 0.45}; ${current === part.id ? "border-color:#f0c878;" : ""}">
        <div style="font-size:14px; color:#fff;">${part.name}${part.model ? ' <span style="color:#8fc7ff; font-size:11px;">Lux3D</span>' : ""}</div>
        <div style="font-size:11px; opacity:.75; margin:2px 0;">${part.desc}</div>
        <div style="font-size:12px; color:#f0c878;">${cost}</div></div>`;
    }
    html += `</div><div style="font-size:12px; opacity:.7; margin-top:8px;">选中后：R 旋转 · 左键放置 · G 拾取最近的 · X 拆除最近的 · Esc 退出</div>`;
    this.showPanel("建造目录", html);
    this.panelBody.querySelectorAll<HTMLElement>(".buildOpt").forEach((el) => {
      el.addEventListener("click", () => {
        const partId = el.dataset.part!;
        this.onBuildSelect?.(partId);
      });
    });
  }

  showInventory(stacks: ItemStack[], onEat: (id: ItemId) => void, onEquip: (id: ItemId) => void) {
    let html = `<div style="display:grid; grid-template-columns:repeat(3,1fr); gap:8px;">`;
    if (!stacks.length) html += `<div style="opacity:.6; grid-column:span 3;">背包是空的，去岛上转转吧。</div>`;
    for (const s of stacks) {
      const def = ITEMS[s.id];
      const act = def.kind === "food" ? `<button data-eat="${s.id}" style="margin-top:4px; background:#4a8f5f; border:none; color:#fff; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:12px;">食用</button>`
        : def.kind === "weapon" ? `<button data-equip="${s.id}" style="margin-top:4px; background:#8f6f3d; border:none; color:#fff; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:12px;">装备</button>` : "";
      html += `<div style="border:1px solid rgba(255,255,255,.15); border-radius:8px; padding:8px;">
        <div style="font-size:14px;">${def.name} <span style="opacity:.7;">×${s.count}</span></div>
        <div style="font-size:11px; opacity:.7; margin-top:2px; min-height:28px;">${def.desc}</div>${act}</div>`;
    }
    html += `</div>`;
    this.showPanel("背包", html);
    this.panelBody.querySelectorAll<HTMLElement>("[data-eat]").forEach((b) => b.addEventListener("click", () => onEat(b.dataset.eat as ItemId)));
    this.panelBody.querySelectorAll<HTMLElement>("[data-equip]").forEach((b) => b.addEventListener("click", () => onEquip(b.dataset.equip as ItemId)));
  }

  showNpcAuth(info: { zone: string; budget: Partial<Record<ItemId, number>> | null; parts: string[]; paused?: boolean; radius?: number }, onAuthorize: (zone: string, budget: Partial<Record<ItemId, number>>, parts: string[], radius: number) => void, onRevoke?: () => void, onPause?: (paused: boolean) => void) {
    const inv = (this as unknown as { _authInv?: ItemStack[] })._authInv ?? [];
    const money = (id: ItemId) => inv.find((s) => s.id === id)?.count ?? 0;
    const opt = (id: ItemId) => `<option value="${id}">${ITEMS[id].name}（有 ${money(id)}）</option>`;
    let html = `
      <div style="font-size:13px; line-height:1.7; opacity:.85;">授权居民在指定区域内用指定预算进行小型建设。建设遵守同一套放置规则，可随时收回授权。</div>
      <div style="margin-top:10px;">
        <div style="font-size:13px; margin-bottom:4px;">建设区域：${info.zone}</div>
        <label style="font-size:13px;">区域半径 <input id="authRadius" type="number" min="2" max="12" step="0.5" value="${info.radius ?? 5.5}" style="width:56px; background:rgba(255,255,255,.08); color:#fff; border:1px solid rgba(255,255,255,.2); border-radius:6px; padding:4px;"> 米</label>
        <div style="display:flex; gap:10px; align-items:center; font-size:13px;">
          预算上限：
          <select id="authItem1" style="background:rgba(255,255,255,.08); color:#fff; border:1px solid rgba(255,255,255,.2); border-radius:6px; padding:4px;">${opt("wheat")}${opt("windcrystal")}${opt("floatstone")}</select>
          <input id="authNum1" type="number" min="0" max="20" value="4" style="width:56px; background:rgba(255,255,255,.08); color:#fff; border:1px solid rgba(255,255,255,.2); border-radius:6px; padding:4px;">
        </div>
        <div style="display:flex; gap:10px; align-items:center; font-size:13px; margin-top:6px;">
          <select id="authItem2" style="background:rgba(255,255,255,.08); color:#fff; border:1px solid rgba(255,255,255,.2); border-radius:6px; padding:4px;">${opt("wheat")}${opt("windcrystal")}${opt("floatstone")}</select>
          <input id="authNum2" type="number" min="0" max="20" value="0" style="width:56px; background:rgba(255,255,255,.08); color:#fff; border:1px solid rgba(255,255,255,.2); border-radius:6px; padding:4px;">
        </div>
        <div style="font-size:12px; opacity:.7; margin-top:8px;">可建部件：${info.parts.map((p) => BUILD_CATALOG.find((x) => x.id === p)?.name ?? p).join("、")}</div>
        <button id="authGo" style="margin-top:12px; background:#3d6e8f; border:none; color:#fff; border-radius:6px; padding:8px 20px; cursor:pointer;">开始授权</button>
        ${info.budget ? '<button id="authRevoke" style="margin:12px 0 0 8px; background:#75444a; border:none; color:#fff; border-radius:6px; padding:8px 16px; cursor:pointer;">收回授权</button>' : ""}
        ${info.budget ? `<button id="authPause" style="margin:12px 0 0 8px; background:#675d3d; border:none; color:#fff; border-radius:6px; padding:8px 16px; cursor:pointer;">${info.paused ? "继续建设" : "暂停建设"}</button>` : ""}
      </div>`;
    if (info.budget) {
      html += `<div style="margin-top:8px; font-size:12px; color:#8fd0a0;">当前授权生效中：${Object.entries(info.budget).map(([k, v]) => `${ITEMS[k as ItemId].name}×${v}`).join("，")}</div>`;
    }
    this.showPanel("NPC 建设授权", html);
    this.panelBody.querySelector("#authGo")!.addEventListener("click", () => {
      const i1 = (this.panelBody.querySelector("#authItem1") as HTMLSelectElement).value as ItemId;
      const n1 = parseInt((this.panelBody.querySelector("#authNum1") as HTMLInputElement).value || "0");
      const i2 = (this.panelBody.querySelector("#authItem2") as HTMLSelectElement).value as ItemId;
      const n2 = parseInt((this.panelBody.querySelector("#authNum2") as HTMLInputElement).value || "0");
      const budget: Partial<Record<ItemId, number>> = {};
      if (n1 > 0) budget[i1] = n1;
      if (n2 > 0) budget[i2] = n2;
      const radius = Math.max(2, Math.min(12, Number((this.panelBody.querySelector("#authRadius") as HTMLInputElement).value) || 5.5));
      onAuthorize("家园空岛中央广场", budget, ["railing", "planter", "lantern", "floor", "table"], radius);
    });
    this.panelBody.querySelector("#authRevoke")?.addEventListener("click", () => onRevoke?.());
    this.panelBody.querySelector("#authPause")?.addEventListener("click", () => onPause?.(!info.paused));
  }

  setAuthInventory(stacks: ItemStack[]) {
    (this as unknown as { _authInv?: ItemStack[] })._authInv = stacks;
  }

  // ---- 气泡 ----
  showBubble(id: string, worldPos: Vector3, camera: Camera, scene: Scene, text: string) {
    let el = this.bubbleLayer.querySelector<HTMLDivElement>(`#bubble_${id}`);
    if (!el) {
      el = document.createElement("div");
      el.id = `bubble_${id}`;
      el.style.cssText = `position:absolute; transform:translate(-50%,-100%); background:rgba(18,28,40,.92);
        border:1px solid rgba(255,255,255,.25); border-radius:10px; padding:8px 12px; font-size:13px; max-width:280px;
        line-height:1.6; pointer-events:auto; box-shadow:0 4px 16px rgba(0,0,0,.35);`;
      this.bubbleLayer.appendChild(el);
    }
    const p = Vector3.Project(worldPos, Matrix.Identity(), scene.getTransformMatrix(), camera.viewport.toGlobal(engineRenderW, engineRenderH));
    if (p.z < 0 || p.z > 1) { el.style.display = "none"; return; }
    el.style.display = "block";
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.textContent = text;
  }

  hideBubble(id: string) {
    const el = this.bubbleLayer.querySelector<HTMLDivElement>(`#bubble_${id}`);
    if (el) el.style.display = "none";
  }

  setPerf(text: string, visible: boolean) {
    this.perfEl.textContent = text;
    this.perfEl.style.opacity = visible ? "1" : "0";
    this.wsIndicator.style.display = visible ? "block" : "none";
  }

  edgeArrow(el: HTMLDivElement | null, x: number, y: number, visible: boolean) {
    const arrow = this.root.querySelector<HTMLDivElement>("#edgeArrow")!;
    if (!visible) { arrow.style.display = "none"; return; }
    arrow.style.display = "block";
    arrow.style.left = `${x}px`;
    arrow.style.top = `${y}px`;
  }

  showTitle(hasSave: boolean, onStart: () => void, onContinue: () => void, onExport?: () => void, onImport?: (file: File) => void, onCloudRestore?: () => void) {
    const t = document.createElement("div");
    t.style.cssText = `position:fixed; inset:0; z-index:50; display:flex; flex-direction:column; align-items:center; justify-content:center;
      background:linear-gradient(180deg, rgba(10,16,26,.42), rgba(8,14,26,.6)); color:#fff;
      font-family:"Microsoft YaHei", system-ui, sans-serif; pointer-events:auto;
      text-shadow:0 1px 6px rgba(0,0,0,.55);`;
    t.innerHTML = `
      <div style="font-size:46px; letter-spacing:12px; color:#ffd98f; text-shadow:0 2px 22px rgba(240,190,110,.55), 0 1px 6px rgba(0,0,0,.6);">云屿之歌</div>
      <div style="font-size:14px; opacity:.9; margin:10px 0 26px; letter-spacing:4px;">带着自己的家，飞越云海、探索山河</div>
      <div style="display:flex; gap:14px; margin-bottom:30px;">
        ${hasSave ? `<button id="btnContinue" style="padding:10px 34px; font-size:16px; background:#3d6e8f; color:#fff; border:none; border-radius:8px; cursor:pointer;">继续旅程</button>` : ""}
        <button id="btnStart" style="padding:10px 34px; font-size:16px; background:${hasSave ? "rgba(255,255,255,.14)" : "#3d6e8f"}; color:#fff; border:none; border-radius:8px; cursor:pointer;">新的旅程</button>
      </div>
      <div style="display:flex; gap:10px; margin-top:-18px; margin-bottom:20px;">
        ${hasSave ? '<button id="btnExport" style="padding:6px 12px; background:rgba(255,255,255,.14); color:#fff; border:0; border-radius:6px; cursor:pointer;">导出存档</button>' : ""}
        <button id="btnImport" style="padding:6px 12px; background:rgba(255,255,255,.14); color:#fff; border:0; border-radius:6px; cursor:pointer;">导入存档</button><input id="saveFile" type="file" accept="application/json,.json" style="display:none">
        <button id="btnCloud" style="padding:6px 12px; background:rgba(255,255,255,.14); color:#fff; border:0; border-radius:6px; cursor:pointer;">云端副本</button>
      </div>
      <div id="titleStatus" role="status" style="max-width:650px; padding:0 20px; margin-bottom:16px; text-align:center; color:#ffd98f;"></div>
      <div style="font-size:12.5px; opacity:.85; line-height:2; text-align:center;">
        WASD 移动 · 点击画面锁定鼠标视角 · 空格 跳跃/上升 · F 滑翔(空中)/停泊 · E 交互/上下舟 · Shift 疾跑/下降<br>
        B 建造 · I 背包 · K 居民授权 · P 保存 · Esc 关闭/退出 · F3 性能面板
      </div>`;
    document.body.appendChild(t);
    this.titleEl = t;
    t.querySelector("#btnStart")!.addEventListener("click", () => onStart());
    t.querySelector("#btnContinue")?.addEventListener("click", () => onContinue());
    t.querySelector("#btnExport")?.addEventListener("click", () => onExport?.());
    const input = t.querySelector<HTMLInputElement>("#saveFile")!;
    t.querySelector("#btnImport")?.addEventListener("click", () => input.click());
    input.addEventListener("change", () => { const file = input.files?.[0]; if (file) onImport?.(file); });
    t.querySelector("#btnCloud")?.addEventListener("click", () => onCloudRestore?.());
  }

  titleStatus(message: string) {
    const status = this.titleEl?.querySelector("#titleStatus");
    if (status) status.textContent = message;
    else this.toast(message, 7);
  }

  closeTitle() {
    this.titleEl?.remove();
    this.titleEl = null;
  }
}

let engineRenderW = 1280, engineRenderH = 720;
export function setEngineSize(w: number, h: number) { engineRenderW = w; engineRenderH = h; }
