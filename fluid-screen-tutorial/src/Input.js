/**
 * Input.js — 鼠标 / 触摸 / 滚动 输入系统
 *
 * 提供两类坐标：
 *   - mouseXY         : NDC [-1, 1]（three.js raycaster 用）
 *   - mousePixelXY     : 像素坐标 [0, w * h]（ScreenPaint 笔刷用）
 * 并记录:
 *   - isDown / justPressed  : 按钮按下状态（本帧是否刚按下）
 *   - hadMoved              : 本帧是否有移动
 *   - scrollY / scrollDelta
 *
 * 使用:
 *   const input = new Input(window);
 *   input.update(); // 每帧调用，刷新 prev 和 delta
 */

export class Input {

  /**
   * @param {HTMLElement|Window} target — 事件监听目标
   */
  constructor(target = window) {
    // 保存事件监听目标（通常是 window，便于统一销毁）
    this.target = target;

    // NDC 坐标
    // 当前帧指针的归一化设备坐标，范围 [-1,1]，y 向上
    this.mouseXY = { x: 0, y: 0 };
    // 上一帧指针的 NDC 坐标，用来判断本帧是否移动
    this.prevMouseXY = { x: 0, y: 0 };

    // 像素坐标（用于 ScreenPaint 的笔刷绘制）
    // 当前帧指针的像素坐标，左上角为原点
    this.mousePixelXY = { x: 0, y: 0 };
    // 上一帧的像素坐标（ScreenPaint 计算笔画速度时也会自己维护一份）
    this.prevMousePixelXY = { x: 0, y: 0 };

    // 按钮状态
    // 指针当前是否按下
    this.isDown = false;
    // 本帧是否刚按下（上升沿），消费方用完可在下一帧自动失效
    this.justPressed = false; // 本帧刚从 false → true
    // 本帧是否发生过移动
    this.hadMoved = false;
    // 指针是否真正进入过画面（进入前不推动物理，防止默认位置把球簇炸散）
    this.hasPointer = false;  // 指针是否真正进入过画面（进入前不推动物理）
    // 上一帧的按下状态，用于计算 justPressed 的上升沿
    this._lastIsDown = false;

    // 滚动
    // 当前页面滚动位置
    this.scrollY = window.scrollY || 0;
    // 本帧累计的滚动增量（wheel + scroll 事件共同累加）
    this.scrollDelta = 0;

    // 初始化
    // 先绑定事件，再跑一次 update 建立初始的 prev 基准，避免首帧产生巨大 delta
    this._bind();
    this.update();
  }

  /** 绑定所有原生事件 */
  _bind() {
    // 取监听目标的短引用
    const t = this.target;

    // —— 鼠标 / Pointer ——
    // 移动：更新 NDC 与像素坐标
    t.addEventListener('pointermove', this._onMove);
    // 按下：置 isDown 并同步坐标
    t.addEventListener('pointerdown', this._onDown);
    // 抬起：清除按下状态
    t.addEventListener('pointerup', this._onUp);
    // 指针离开目标区域时也视为抬起，避免"卡住"一直按着
    t.addEventListener('pointerleave', this._onUp);

    // —— 触摸 ——
    // 触摸开始（passive 表示不会调用 preventDefault，交给浏览器继续滚动）
    t.addEventListener('touchstart', this._onTouchStart, { passive: true });
    // 触摸移动
    t.addEventListener('touchmove', this._onTouchMove, { passive: true });
    // 触摸结束
    t.addEventListener('touchend', this._onTouchEnd);

    // —— 滚动 ——
    // 滚轮事件累加 deltaY
    t.addEventListener('wheel', this._onWheel, { passive: true });
    // 页面滚动监听固定挂在 window 上（scroll 事件不冒泡到普通元素）
    window.addEventListener('scroll', this._onScroll);
  }

  /** 解绑所有事件 — 清理时调用 */
  dispose() {
    // 取监听目标的短引用
    const t = this.target;
    // 以下逐一移除，且必须传入同样的函数引用与第三个参数配置
    t.removeEventListener('pointermove', this._onMove);
    t.removeEventListener('pointerdown', this._onDown);
    t.removeEventListener('pointerup', this._onUp);
    t.removeEventListener('pointerleave', this._onUp);
    t.removeEventListener('touchstart', this._onTouchStart);
    t.removeEventListener('touchmove', this._onTouchMove);
    t.removeEventListener('touchend', this._onTouchEnd);
    t.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('scroll', this._onScroll);
  }

  // ———————— 内部 ————————

  _updateXY(clientX, clientY) {
    // 视口宽高（CSS 像素）
    const w = window.innerWidth;
    // 视口高（CSS 像素）
    const h = window.innerHeight;
    // NDC x：把 [0,w] 线性映射到 [-1,1]
    this.mouseXY.x = (clientX / w) * 2 - 1;
    // NDC y：屏幕 y 向下，NDC y 向上，故取反
    this.mouseXY.y = -(clientY / h) * 2 + 1;
    // 像素坐标直接沿用 clientX（相对视口左上角）
    this.mousePixelXY.x = clientX;
    // 像素坐标 y
    this.mousePixelXY.y = clientY;
    // 标记指针已进入过画面
    this.hasPointer = true;
  }

  // 指针移动 → 仅更新坐标
  _onMove = (e) => this._updateXY(e.clientX, e.clientY);
  // 指针按下 → 置按下态并同步坐标（按下瞬间的位置也要记录，避免笔画断点）
  _onDown = (e) => { this.isDown = true; this._updateXY(e.clientX, e.clientY); };
  // 指针抬起 → 清除按下态
  _onUp = () => { this.isDown = false; };

  // 触摸开始 → 以第一根手指为准，等价于鼠标按下
  _onTouchStart = (e) => {
    // 只有存在触点时才处理
    if (e.touches[0]) { this.isDown = true; this._updateXY(e.touches[0].clientX, e.touches[0].clientY); }
  };
  // 触摸移动 → 更新到当前第一根手指的位置
  _onTouchMove = (e) => {
    // 只有存在触点时才处理
    if (e.touches[0]) this._updateXY(e.touches[0].clientX, e.touches[0].clientY);
  };
  // 触摸结束 → 清除按下态
  _onTouchEnd = () => { this.isDown = false; };

  // 滚轮：累加 deltaY（正负代表方向），由 update 做平滑衰减
  _onWheel = (e) => { this.scrollDelta += e.deltaY; };
  // 页面滚动：用位置差累加增量，并同步当前 scrollY
  _onScroll = () => {
    // 读取最新滚动位置
    const newY = window.scrollY || 0;
    // 位置差累加进 delta（兼容键盘、滚动条等非 wheel 触发的滚动）
    this.scrollDelta += newY - this.scrollY;
    // 更新基准
    this.scrollY = newY;
  };

  // ———————— 每帧调用 ————————

  /**
   * 更新 prev 状态和瞬时标记，应在每帧开头调用
   */
  update() {
    // 位移超过阈值 1e-5 才算移动（消除浮点噪声导致的误判）
    this.hadMoved = (
      Math.abs(this.mouseXY.x - this.prevMouseXY.x) > 1e-5 ||
      Math.abs(this.mouseXY.y - this.prevMouseXY.y) > 1e-5
    );
    // 上升沿检测：本帧按下且上帧未按下 → 刚按下
    this.justPressed = this.isDown && !this._lastIsDown;

    // 记录本帧 NDC 坐标，供下一帧比较
    this.prevMouseXY.x = this.mouseXY.x;
    this.prevMouseXY.y = this.mouseXY.y;
    // 记录本帧像素坐标
    this.prevMousePixelXY.x = this.mousePixelXY.x;
    this.prevMousePixelXY.y = this.mousePixelXY.y;
    // 记录本帧按下状态
    this._lastIsDown = this.isDown;

    // scrollDelta 自然衰减，让滚动更平滑
    // 每帧乘 0.9：增量不会一直累加，而是逐渐归零
    this.scrollDelta *= 0.9;
  }
}
