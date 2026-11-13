/**
 * FluidExperience.js — 鼠标流体效果页的运行时
 *
 * ─────────────────────────────────────────────────────────────
 * 每帧渲染顺序
 * ─────────────────────────────────────────────────────────────
 *   ① Input.update()            记录本帧鼠标位置/是否移动
 *   ② ScreenPaint.update()      在 1/4 分辨率 RT 里"画"速度和墨量
 *   ③ 渲染基础画面 → baseRT      （米白底 + 彩色软斑 + 细圆环）
 *   ④ ScreenPaintDistortion     用速度场对 baseRT 做 9 次偏移采样 + 色散 → 屏幕
 *
 * 之所以要先把画面渲染到 RT 而不是直接画到屏幕：
 * 折射后处理必须能"读到整张画面"，而帧缓冲不能在绘制过程中被自己采样，
 * 所以基础画面 → 离屏纹理 → 后处理采样 → 屏幕，是标准的两段式后处理结构。
 *
 * 分辨率策略：
 *   - baseRT / 屏幕       : 全分辨率（画面清晰度）
 *   - paint / 速度模拟    : 1/4（流体不需要高频细节，省 16 倍填充率）
 *   - low / 模糊速度场    : 1/8（更平滑的流场，避免平流锯齿）
 */

// Three.js 主库
import * as THREE from 'three';
// 流体模拟系统：在低分辨率 RT 中扩散速度场与墨量
import { ScreenPaint } from './ScreenPaint.js';
// 折射后处理：采样速度场对基础画面做偏移与色散
import { ScreenPaintDistortion } from './ScreenPaintDistortion.js';
// 统一输入管理
import { Input } from './Input.js';
// 基础画面的 GLSL（米白底 + 彩色软斑 + 圆环）
import { fluidBaseVertexShader, fluidBaseFragmentShader } from './fluidBase.js';
// 调试用参数面板（lil-gui）
import { createFluidGUI } from './FluidGUI.js';
// 后期编排器（流体折射 pass 之后继续接 Final / Smaa / Fsr）
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
// Pass 基类：自定义一个「把 baseRT 经流体折射后写入 composer 缓冲」的通道
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';
// 原站 PostEffect 队列的收尾段
import { FinalPass } from './FinalPass.js';
import { SmaaPass } from './SmaaPass.js';
import { FsrPass } from './FsrPass.js';

/** 全屏三角形（覆盖整个 NDC，比两个三角形的四边形少一次光栅化边界） */
function makeFullscreenGeometry() {
  // 空的几何体容器
  const geo = new THREE.BufferGeometry();
  // 顶点坐标：三个点 (-1,-1)/(3,-1)/(-1,3) 覆盖整个裁剪空间，多余部分被裁掉
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    // 每顶点 3 个分量（x, y, z），z 固定 0
    [-1, -1, 0, 3, -1, 0, -1, 3, 0], 3
  ));
  // 对应 UV：0~2 让贴图坐标同样铺满视口（超出 1 的部分由裁剪丢弃）
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(
    // 每顶点 2 个分量
    [0, 0, 2, 0, 0, 2], 2
  ));
  // 返回构造好的几何体
  return geo;
}

/**
 * DistortionPass — 把 ScreenPaintDistortion 包装成 composer 的一个 pass
 *
 * ScreenPaintDistortion 原本直接渲染到屏幕（target = null），
 * 现在改为写入 composer 的写缓冲，后续还能继续接 Final / Smaa / Fsr。
 */
class DistortionPass extends Pass {
  /**
   * @param {ScreenPaintDistortion} distortion — 折射实现
   * @param {THREE.WebGLRenderTarget} sourceRT — 已渲染好的基础画面
   */
  constructor(distortion, sourceRT) {
    // 初始化 Pass（enabled / needsSwap / renderToScreen）
    super();
    // 保存折射实例
    this.distortion = distortion;
    // 保存基础画面 RT
    this.sourceRT = sourceRT;
  }

  render(renderer, writeBuffer /*, readBuffer, deltaTime */) {
    // 折射 pass 读取 sourceRT；作为最后一个启用 pass 时直接写屏幕
    this.distortion.render(this.sourceRT.texture, this.renderToScreen ? null : writeBuffer);
  }
}

// 流体效果运行时：负责创建/销毁全部 GPU 资源与帧循环
export class FluidExperience {

  // options 目前支持关闭 GUI 与覆盖后处理参数
  constructor(options = {}) {
    // 挂载容器
    this.container = null;
    // WebGL 渲染器
    this.renderer = null;
    // 流体模拟实例
    this.screenPaint = null;
    // 折射后处理实例
    this.distortion = null;
    // 输入系统
    this.input = null;
    // 调试面板实例
    this.gui = null;

    // 是否显示实时参数面板（可通过 options.gui = false 关闭）
    this.showGUI = options.gui !== false;

    // 后处理参数（默认值与线上 bundle 一致，可在这里微调演示强度）
    this.distortionOptions = {
      // 折射偏移强度
      amount: 3,
      // RGB 三通道错位量（色散）
      rgbShift: 0.5,
      // 速度场对偏移量的整体放大倍数
      multiplier: 5,
      // 模拟墨量对画面颜色的影响倍数
      colorMultiplier: 10,
      // 明暗遮蔽强度
      shade: 1.25,
      // 允许外部通过 options.distortion 覆盖任意一项
      ...options.distortion,
    };

    // requestAnimationFrame 句柄
    this._raf = 0;
    // 事件注销控制器
    this._abort = null;
    // 累计运行时间（秒），传给基础画面着色器做动画
    this._time = 0;
    // 上一帧时间（秒）
    this._lastTime = 0;
  }

  mount(container) {
    // 容器缺失或已挂载则跳过，保证重复调用安全
    if (!container || this.container) return;
    // 记录容器
    this.container = container;

    // 初始宽度：容器优先，兜底窗口宽度
    const w = container.clientWidth || window.innerWidth;
    // 初始高度同理
    const h = container.clientHeight || window.innerHeight;

    // —— 渲染器 ——
    this.renderer = new THREE.WebGLRenderer({
      // 不透明画布
      alpha: false,
      // 开启抗锯齿（主要影响屏幕输出的边缘）
      antialias: true,
      // 优先高性能 GPU
      powerPreference: 'high-performance',
    });
    // 像素比封顶 2，控制后处理填充率
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 按容器尺寸设置画布，false 表示不写 CSS 尺寸
    this.renderer.setSize(w, h, false);
    // 清屏色与页面背景一致，避免边缘露出白底
    this.renderer.setClearColor(0x141515, 1);
    // canvas 挂载到容器
    container.appendChild(this.renderer.domElement);

    // —— 基础画面（离屏） ——
    // 离屏渲染目标：后处理需要把整张画面当纹理采样，所以先渲到这里
    this._baseRT = new THREE.WebGLRenderTarget(w, h, {
      // 缩小采样时线性过滤，避免块状
      minFilter: THREE.LinearFilter,
      // 放大采样同样线性
      magFilter: THREE.LinearFilter,
      // 全屏平面不需要深度缓冲
      depthBuffer: false,
      // 也不需要模板缓冲
      stencilBuffer: false,
      // 8bit 足够（画面是 LDR 风格）
      type: THREE.UnsignedByteType,
    });

    // 基础画面材质：RawShaderMaterial 表示 shader 自己声明 attribute/uniform
    this._baseMaterial = new THREE.RawShaderMaterial({
      uniforms: {
        // 分辨率，用于把 uv 换算成像素坐标
        u_resolution: { value: new THREE.Vector2(w, h) },
        // 时间，驱动软斑漂移
        u_time: { value: 0 },
      },
      // 全屏三角形顶点着色器
      vertexShader: fluidBaseVertexShader,
      // 米白底 + 彩色软斑片元着色器
      fragmentShader: fluidBaseFragmentShader,
      // 全屏 pass 不需要深度测试
      depthTest: false,
      // 也不需要写深度
      depthWrite: false,
    });

    // 构造全屏三角形几何体
    this._baseGeo = makeFullscreenGeometry();
    // 用几何体 + 材质组装网格
    this._baseMesh = new THREE.Mesh(this._baseGeo, this._baseMaterial);
    // 关闭视锥剔除，避免全屏三角形被误判剔除而不渲染
    this._baseMesh.frustumCulled = false;
    // 专门装全屏网格的最小场景
    this._baseScene = new THREE.Scene();
    // 把网格加入离屏场景
    this._baseScene.add(this._baseMesh);
    // 默认相机即可：顶点着色器直接输出裁剪坐标，不依赖相机矩阵
    this._baseCamera = new THREE.Camera();

    // —— 流体模拟 + 折射 ——
    // 流体模拟：内部按 1/4、1/8 分辨率分配速度/墨量 RT
    this.screenPaint = new ScreenPaint(this.renderer, w, h);
    // 折射后处理：读取流体速度场，对 baseRT 做多次偏移采样
    this.distortion = new ScreenPaintDistortion(
      // 渲染器
      this.renderer,
      // 提供速度场纹理与参数的模拟实例
      this.screenPaint,
      // 强度等可调参数
      this.distortionOptions
    );

    // —— 后期链：折射 → Final → Smaa → Fsr ——
    // 原站 PostEffect 队列按 renderOrder 执行，这里保持同样的相对顺序
    this.composer = new EffectComposer(this.renderer);
    // 按当前尺寸分配 composer 内部两张 RT
    this.composer.setSize(w, h);
    // ① 折射 pass：把 baseRT 经速度场扰动后写入 composer 缓冲
    this.distortionPass = new DistortionPass(this.distortion, this._baseRT);
    // 加入链
    this.composer.addPass(this.distortionPass);
    // ② Final：暗角 / 颗粒 / 调色（原站默认关闭）
    this.finalPass = new FinalPass();
    // 默认关闭
    this.finalPass.enabled = false;
    // 温和的暗角范围
    this.finalPass.vignetteFrom = 1.1;
    this.finalPass.vignetteTo = 2.1;
    // 加入链
    this.composer.addPass(this.finalPass);
    // ③ Smaa：常驻抗锯齿
    this.smaaPass = new SmaaPass();
    // 默认开启
    this.smaaPass.enabled = true;
    // 加入链
    this.composer.addPass(this.smaaPass);
    // ④ Fsr：原站仅 UP_SCALE>1 时启用，这里默认关闭
    this.fsrPass = new FsrPass();
    // 默认关闭
    this.fsrPass.enabled = false;
    // 加入链
    this.composer.addPass(this.fsrPass);

    // —— 输入 ——
    // 鼠标/触摸监听挂在 window 上
    this.input = new Input(window);

    // —— 实时参数面板 ——
    // 演示模式下默认开启，便于现场调节强度
    if (this.showGUI) {
      // 面板直接操作 screenPaint 与 distortion 的属性
      this.gui = createFluidGUI(this.screenPaint, this.distortion);
    }

    // 创建事件注销控制器
    this._abort = new AbortController();
    // 窗口尺寸变化时重建各 RT 与 uniform
    window.addEventListener('resize', () => this.resize(), { signal: this._abort.signal });

    // 记录起始时间，避免首帧 dt 过大
    this._lastTime = performance.now() / 1000;
    // 调试句柄：在控制台通过 window.__fluid 查看 / 切换后期 pass 与参数
    window.__fluid = this;
    // 启动帧循环
    this._animate();
  }

  resize() {
    // 未挂载或已销毁时忽略
    if (!this.container || !this.renderer) return;

    // 新宽度：容器优先
    const w = this.container.clientWidth || window.innerWidth;
    // 新高度
    const h = this.container.clientHeight || window.innerHeight;

    // 重新读取像素比（拖到不同 DPI 屏幕时会变）
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 更新画布后备缓冲尺寸
    this.renderer.setSize(w, h, false);
    // 重建离屏渲染目标的尺寸（会重新分配 GPU 纹理）
    this._baseRT.setSize(w, h);
    // 同步基础画面着色器的分辨率 uniform，否则软斑比例会拉伸
    this._baseMaterial.uniforms.u_resolution.value.set(w, h);
    // 让流体模拟按新尺寸重算内部 1/4、1/8 RT
    this.screenPaint.resize(w, h);
    // 后处理链同步新尺寸（composer 内部会乘以 pixelRatio）
    this.composer?.setSize(w, h);
  }

  // 帧循环（箭头函数绑定 this，可直接作为 rAF 回调）
  _animate = () => {
    // 预约下一帧
    this._raf = requestAnimationFrame(this._animate);

    // 当前时间（秒）
    const now = performance.now() / 1000;
    // 帧间隔并限幅 50ms，防止切后台回来时模拟爆掉
    const dt = Math.min(now - this._lastTime, 0.05);
    // 记录本帧时间
    this._lastTime = now;
    // 累计时间，保证暂停后动画连续
    this._time += dt;

    // ① 输入
    this.input.update();

    // ② 流体模拟：注意坐标系差异
    //    mouseXY        = NDC（左下原点，y 向上）→ 用于写入 paint 像素坐标
    //    mousePixelXY   = CSS 像素（左上原点，y 向下）→ 用于计算移动速度
    this.screenPaint.update(
      // 帧间隔
      dt,
      // 像素坐标（算速度）
      this.input.mousePixelXY,
      // NDC 坐标（写纹理）
      this.input.mouseXY,
      // 本帧是否发生了移动，没动就不新增墨量
      this.input.hadMoved
    );

    // ③ 渲染基础画面到离屏纹理
    // 推进基础画面的时间动画
    this._baseMaterial.uniforms.u_time.value = this._time;
    // 把后续绘制重定向到离屏 RT
    this.renderer.setRenderTarget(this._baseRT);
    // 绘制全屏三角形（米白底 + 彩色软斑）
    this.renderer.render(this._baseScene, this._baseCamera);

    // ④ 折射 + 后处理链输出到屏幕（composer 会把最后一个启用的 pass 上屏）
    this.composer.render(dt);
  };

  dispose() {
    // 停止帧循环
    cancelAnimationFrame(this._raf);
    // 移除调试句柄
    if (window.__fluid === this) window.__fluid = null;
    // 句柄归零
    this._raf = 0;

    // 注销 resize 等事件
    this._abort?.abort();
    // 清空控制器
    this._abort = null;

    // 销毁调试面板（同时移除它的 DOM）
    this.gui?.destroy();
    // 断开引用
    this.gui = null;

    // 释放输入监听
    this.input?.dispose();
    // 断开引用
    this.input = null;

    // 释放流体模拟内部所有 RT
    this.screenPaint?.dispose();
    // 断开引用
    this.screenPaint = null;

    // 释放折射后处理（材质/RT）
    this.distortion?.dispose();
    // 断开引用
    this.distortion = null;

    // 后期 pass 自身资源（composer.dispose 不会释放 pass）
    this.finalPass?.dispose?.();
    // SMAA 的 edges/weights RT 与 LUT
    this.smaaPass?.dispose?.();
    // FSR 的材质与中转 RT
    this.fsrPass?.dispose?.();
    // composer 内部两张 ping-pong RT
    this.composer?.dispose?.();
    // 断开引用
    this.composer = null;
    this.distortionPass = null;
    this.finalPass = null;
    this.smaaPass = null;
    this.fsrPass = null;

    // 释放离屏渲染目标（GPU 纹理）
    this._baseRT?.dispose();
    // 断开引用
    this._baseRT = null;
    // 释放基础画面材质（着色器程序）
    this._baseMaterial?.dispose();
    // 断开引用
    this._baseMaterial = null;
    // 释放全屏三角形几何体
    this._baseGeo?.dispose();
    // 断开引用
    this._baseGeo = null;
    // 网格本身无需 GPU 资源，仅清引用
    this._baseMesh = null;
    // 清离屏场景
    this._baseScene = null;
    // 清相机
    this._baseCamera = null;

    // 最后释放渲染器与 WebGL 上下文
    if (this.renderer) {
      // 释放渲染器缓存
      this.renderer.dispose();
      // 强制丢弃上下文，避免超出浏览器上下文上限
      this.renderer.forceContextLoss();
      // 从 DOM 移除 canvas
      this.renderer.domElement.remove();
      // 断开引用
      this.renderer = null;
    }

    // 清空容器引用
    this.container = null;
  }
}
