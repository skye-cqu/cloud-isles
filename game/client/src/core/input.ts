// 键鼠输入：持续状态 + 单帧触发。
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  /** 鼠标位移（指针锁定时） */
  mouseDX = 0;
  mouseDY = 0;
  mouseLeft = false;
  mouseLeftPressed = false;
  mouseRight = false;
  wheel = 0;
  /** UI 面板打开时，游戏输入被吞掉 */
  uiCapture = false;
  onKeyPress?: (code: string) => void;

  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      const code = e.code;
      this.down.add(code);
      this.pressed.add(code);
      this.onKeyPress?.(code);
      if (["Space", "Tab", "F1", "F2"].includes(code) && !this.uiCapture) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    });
    // 按键与鼠标按下：pointerdown 是浏览器真实输入链（Babylon 会对 canvas pointerdown
    // 调 preventDefault，但不会阻断 window/canvas 监听）；mousedown 兼容保留。
    const onDown = (button: number) => {
      if (button === 0) { this.mouseLeft = true; this.mouseLeftPressed = true; }
      if (button === 2) this.mouseRight = true;
    };
    el.addEventListener("pointerdown", (e) => onDown(e.button));
    el.addEventListener("mousedown", (e) => onDown(e.button));
    window.addEventListener("pointerup", (e) => {
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.mouseLeft = false;
      if (e.button === 2) this.mouseRight = false;
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousemove", (e) => {
      if (document.pointerLockElement) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });
    el.addEventListener("wheel", (e) => { this.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener("blur", () => this.clearAll());
  }

  isDown(...codes: string[]) { return codes.some((c) => this.down.has(c)); }
  wasPressed(...codes: string[]) { return codes.some((c) => this.pressed.has(c)); }
  wasReleased(...codes: string[]) { return codes.some((c) => this.released.has(c)); }

  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mouseDX = 0; this.mouseDY = 0;
    this.mouseLeftPressed = false;
    this.wheel = 0;
  }

  clearAll() {
    this.down.clear();
    this.pressed.clear();
    this.mouseLeft = false; this.mouseRight = false;
  }

  requestPointerLock() {
    if (!document.pointerLockElement) this.el.requestPointerLock?.();
  }
  releasePointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
