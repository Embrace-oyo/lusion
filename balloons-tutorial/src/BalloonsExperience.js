/**
 * BalloonsExperience — 主页气球效果的运行时封装
 *
 * 把原来写在 main.js 里的渲染循环、依赖装配、事件绑定收敛到这里，
 * 使其可以被 Vue 路由页面挂载 / 卸载，反复进出不会泄漏 WebGL 资源。
 *
 * 关键参数全部来自线上 bundle:
 *   - 相机 FOV 25 / 位于 (0,0,17.5) / 看向原点
 *   - 开场 dolly-zoom: z 25 → 17.5，同时 FOV 补偿 100 → 0（ease.backOut）
 *   - 渲染器不透明背景 + 近黑色 clear (#141515)
 */

// Three.js 主库，提供渲染器/场景/向量等基础能力
import * as THREE from 'three';
// 后期编排器：pass 之间自动 ping-pong 两张 RT
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
// 场景渲染 pass：把场景渲进 composer 的读缓冲
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
// 原站 PostEffect 队列的收尾段
import { FinalPass } from './FinalPass.js';
import { SmaaPass } from './SmaaPass.js';
import { FsrPass } from './FsrPass.js';
// 气球主体：内部负责创建相机、几何体、材质与每帧动画
import { HomeBalloons } from './HomeBalloons.js';
// 背景层：全屏平面，用色块 + 蓝噪声做渐变过渡
import { HomeBalloonsBackground } from './HomeBalloonsBackground.js';
// 蓝噪声纹理系统：生成/加载 128×128 噪声图，供各材质抖动采样
import { BlueNoise } from './BlueNoise.js';
// 统一输入管理：鼠标位置、是否移动、指针状态
import { Input } from './Input.js';
// 数学工具：限幅、线性插值、带回弹的缓出
import { clamp, lerp, easeBackOut } from './math.js';

// 清屏色（深灰近黑），与页面背景一致，避免加载瞬间出现白闪
const BG_HEX = 0x141515;
// 相机基准 FOV，开场动画在此基础上叠加 FOV 补偿量，最终回到该值
const BASE_FOV = 25;

// 气球主页效果运行时：管理渲染器、场景、相机与帧循环的完整生命周期
export class BalloonsExperience {

  // 构造函数只声明字段，真正的 WebGL 资源延迟到 mount() 里创建
  constructor() {
    // 挂载容器 DOM（Vue 路由页面里的 .stage）
    this.container = null;
    // WebGL 渲染器，持有 canvas 与 GPU 上下文
    this.renderer = null;
    // 场景根节点
    this.scene = null;
    // 相机由 HomeBalloons 内部创建，这里只保存引用
    this.camera = null;
    // 气球主体对象
    this.balloons = null;
    // 背景层对象
    this.background = null;
    // 蓝噪声纹理系统
    this.blueNoise = null;
    // 输入系统
    this.input = null;

    // 后期编排器（RenderPass → Final → Smaa → Fsr）
    this.composer = null;
    // 场景渲染 pass
    this.renderPass = null;
    // 收尾调色 / 暗角 / dither（原站默认关闭）
    this.finalPass = null;
    // SMAA 抗锯齿（原站常驻）
    this.smaaPass = null;
    // FSR1 锐化（原站仅 UP_SCALE>1 时启用）
    this.fsrPass = null;

    // requestAnimationFrame 的句柄，用于卸载时取消帧循环
    this._raf = 0;
    // AbortController 统一注销本实例注册的所有 DOM 事件
    this._abort = null;
    // 动画起始时间（秒），开场 dolly-zoom 的计时原点
    this._startTime = 0;
    // 上一帧时间（秒），用于求帧间隔 dt
    this._lastTime = 0;
  }

  /** 挂载到指定容器（通常是路由页面的根元素） */
  mount(container) {
    // 没有容器或已经挂载过就直接退出，保证幂等、避免重复创建 GPU 资源
    if (!container || this.container) return;
    // 记录容器，后续 resize 都从它读取尺寸
    this.container = container;

    // 第一步：创建渲染器并插入 canvas
    this._createRenderer();
    // 第二步：装配场景（气球 / 背景 / 蓝噪声 / 输入）
    this._createScene();
    // 第二步半：装配后期链（RenderPass → Final → Smaa → Fsr）
    this._createPostProcessing();
    // 第三步：绑定 resize 与指针交互事件
    this._bindEvents();

    // 记录开场时间零点，作为 dolly-zoom 的计时基准
    this._startTime = performance.now() / 1000;
    // 同步上一帧时间，避免第一帧 dt 异常大导致动画跳帧
    this._lastTime = this._startTime;
    // 调试句柄：与其它页面一致，便于在控制台查看 / 切换后期 pass
    window.__balloons = this;
    // 启动渲染循环
    this._animate();
  }

  /** 卸载并释放全部 GPU 资源与事件监听 */
  dispose() {
    // 停止帧循环，否则后续访问已销毁对象会报错
    cancelAnimationFrame(this._raf);
    // 移除调试句柄
    if (window.__balloons === this) window.__balloons = null;
    // 句柄归零，标记循环已停
    this._raf = 0;

    // 注销通过 AbortController 注册的所有事件（resize / pointerdown）
    this._abort?.abort();
    // 清空句柄
    this._abort = null;

    // 释放输入系统内部的监听
    this.input?.dispose();

    // 递归释放场景内所有几何体、材质与贴图
    if (this.scene) disposeObject3D(this.scene);

    // 后处理 pass 自身资源（composer.dispose 不会释放 pass）
    this.finalPass?.dispose?.();
    // SMAA 的 edges/weights RT 与 LUT
    this.smaaPass?.dispose?.();
    // FSR 的 EASU/RCAS 材质与中转 RT
    this.fsrPass?.dispose?.();
    // composer 内部两张 ping-pong RT
    this.composer?.dispose?.();
    // 断开引用
    this.composer = null;
    this.renderPass = null;
    this.finalPass = null;
    this.smaaPass = null;
    this.fsrPass = null;

    // 蓝噪声持有自有贴图与材质，单独释放
    this.blueNoise?.dispose();
    // 断开引用
    this.blueNoise = null;

    // 渲染器：先 dispose 再强制丢失上下文，最后移除 canvas
    if (this.renderer) {
      // 释放渲染器内部缓存（program、renderTarget 等）
      this.renderer.dispose();
      // 主动丢弃 WebGL 上下文，避免浏览器上下文数量超限
      this.renderer.forceContextLoss();
      // 把 canvas 从 DOM 上摘掉
      this.renderer.domElement.remove();
      // 断开引用
      this.renderer = null;
    }

    // 清空其余引用，帮助 GC 回收
    this.balloons = null;
    // 背景层引用
    this.background = null;
    // 场景引用
    this.scene = null;
    // 相机引用
    this.camera = null;
    // 输入引用
    this.input = null;
    // 容器引用
    this.container = null;
  }

  // ———————————— 初始化 ————————————

  _createRenderer() {
    // 创建渲染器：alpha=false 表示画布不透明（用 clearColor 填满）
    this.renderer = new THREE.WebGLRenderer({
      // 关闭透明通道，省一次混合，同时保证背景色稳定
      alpha: false,
      // 开启 MSAA 抗锯齿，气球边缘更平滑
      antialias: true,
      // 提示浏览器优先使用独立显卡
      powerPreference: 'high-performance',
    });
    // 限制像素比最高 2，兼顾高分屏清晰度与填充率开销
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 按容器初始尺寸设置画布大小，第三个参数 false 表示不改动 CSS 尺寸
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight, false);
    // 设置清屏色为近黑灰，alpha 为 1 完全不透明
    this.renderer.setClearColor(BG_HEX, 1);
    // 把 canvas 挂到容器里，交给页面布局
    this.container.appendChild(this.renderer.domElement);
  }

  _createScene() {
    // 场景根节点，后面所有对象都挂到它下面
    this.scene = new THREE.Scene();

    // 气球主体：相机由它创建（FOV 25 / z 17.5）
    this.balloons = new HomeBalloons();
    // 复用气球内部创建的相机，保证相机参数与原站一致
    this.camera = this.balloons.camera;

    // 蓝噪声（原站 LDR_RGB1_0.png，128×128）
    this.blueNoise = new BlueNoise(this.renderer, {
      // 噪声图分辨率，128 已足够抖动精度
      size: 128,
      // 噪声贴图路径，随项目静态资源打包
      url: '/assets/textures/LDR_RGB1_0.png',
    });
    // 注入共享依赖：气球材质需要渲染器（编译着色器）和噪声贴图
    this.balloons.setDependencies({ renderer: this.renderer, blueNoise: this.blueNoise });

    // 背景
    this.background = new HomeBalloonsBackground();
    // 背景同样需要噪声贴图做色带抖动
    this.background.setDependencies({ blueNoise: this.blueNoise });
    // 背景初始配色取气球当前主题色，保证首帧色彩统一
    this.background.setThemeColor(this.balloons.currentColorHex());

    // 先加背景（不透明全屏面），保证它在气球后面绘制
    this.scene.add(this.background);
    // 再加气球主体
    this.scene.add(this.balloons);

    // 输入监听挂在 window 上，鼠标移出容器也能继续跟踪
    this.input = new Input(window);

    // 立刻按容器尺寸校正一次相机/画布，避免初始宽高比错误
    this.resize();
  }

  _createPostProcessing() {
    // 初始尺寸：容器优先，兜底窗口
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;

    // composer 内部维护两张半浮点 RT，pass 之间自动交换
    this.composer = new EffectComposer(this.renderer);
    // 按当前尺寸分配内部 RT
    this.composer.setSize(w, h);

    // ① 场景渲染 pass：气球 + 背景 → composer 读缓冲
    this.renderPass = new RenderPass(this.scene, this.camera);
    // 加入链
    this.composer.addPass(this.renderPass);

    // ② Final：暗角 / 颗粒 / 调色（原站 useFinal 默认关闭）
    this.finalPass = new FinalPass();
    // 默认关闭，与原站一致
    this.finalPass.enabled = false;
    // 温和的暗角范围（开启时可见）
    this.finalPass.vignetteFrom = 1.1;
    // 完全压黑的距离
    this.finalPass.vignetteTo = 2.1;
    // 加入链
    this.composer.addPass(this.finalPass);

    // ③ Smaa：常驻抗锯齿（原站一直开启）
    this.smaaPass = new SmaaPass();
    // 默认开启
    this.smaaPass.enabled = true;
    // 加入链
    this.composer.addPass(this.smaaPass);

    // ④ Fsr：原站仅在 UP_SCALE>1 时加入；这里保留能力、默认关闭
    this.fsrPass = new FsrPass();
    // 默认关闭
    this.fsrPass.enabled = false;
    // 加入链
    this.composer.addPass(this.fsrPass);
  }

  _bindEvents() {
    // 用一个 AbortController 的信号统一管理事件生命周期
    this._abort = new AbortController();
    // 取出信号，供 addEventListener 的第三个参数使用
    const { signal } = this._abort;

    // 窗口尺寸变化时重新计算渲染尺寸与相机投影
    window.addEventListener('resize', () => this.resize(), { signal });

    // 点击换主题色 + 给所有球一次脉冲（原站 changeHomeHeroColorSignal）
    this.renderer.domElement.addEventListener('pointerdown', () => {
      // 切换到下一套主题配色
      this.balloons.nextColor();
      // 背景色跟随新的主题色，保持整体一致
      this.background.setThemeColor(this.balloons.currentColorHex());
    }, { signal });
  }

  resize() {
    // 未挂载或渲染器已释放时不处理
    if (!this.container || !this.renderer) return;

    // 优先用容器尺寸，容器尚未布局时退回窗口尺寸
    const w = this.container.clientWidth || window.innerWidth;
    // 高度同理，防止容器高度为 0 时画面不可见
    const h = this.container.clientHeight || window.innerHeight;

    // 每帧尺寸变化时重新读取像素比（跨屏拖动窗口会变化）
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 更新画布后备缓冲尺寸
    this.renderer.setSize(w, h, false);

    // 通知气球更新相机宽高比与自身依赖分辨率的 uniform
    this.balloons.resize(w, h);
    // 通知背景更新全屏平面的尺寸参数
    this.background.resize(w, h);
    // 后处理链同步新尺寸（composer 内部会乘以 pixelRatio）
    this.composer?.setSize(w, h);
  }

  // ———————————— 每帧 ————————————

  // 帧循环使用箭头函数，绑定 this，可直接作为 rAF 回调
  _animate = () => {
    // 先预约下一帧，保证即使本帧抛错也不会断循环
    this._raf = requestAnimationFrame(this._animate);

    // 当前时间（秒）
    const now = performance.now() / 1000;
    // 帧间隔并限幅到 50ms，避免切标签页回来时动画巨跳
    const dt = Math.min(now - this._lastTime, 0.05);
    // 记录本帧时间，供下一帧使用
    this._lastTime = now;

    // —— 开场 dolly zoom（原站 homePage.time 0.3 → 2 / 3）——
    // 距挂载经过的时间
    const t = now - this._startTime;
    // 相机位移进度：0.3s 后开始，到 2s 走完，easeBackOut 带轻微过冲回落
    const kPos = easeBackOut(clamp((t - 0.3) / (2 - 0.3), 0, 1));
    // 相机从 z=25 推近到 z=17.5，即“推轨”部分
    this.camera.position.z = lerp(25, 17.5, kPos);
    // 始终看向原点，保证构图居中
    this.camera.lookAt(0, 0, 0);

    // FOV 补偿进度：比推轨更慢，3s 才结束，形成 dolly-zoom 的变焦补偿
    const kFov = easeBackOut(clamp((t - 0.3) / (3 - 0.3), 0, 1));
    // 在基准 FOV 上叠加 100 → 0 的补偿量，起始视野极广、逐渐收窄
    const fov = BASE_FOV + lerp(100, 0, kFov);
    // 只有变化超过阈值才更新投影矩阵，省掉无意义的逐帧重算
    if (Math.abs(this.camera.fov - fov) > 1e-4) {
      // 写入新的视野角
      this.camera.fov = fov;
      // 重建投影矩阵，否则渲染不会生效
      this.camera.updateProjectionMatrix();
    }
    // 手动同步世界矩阵（本场景没有父级变换，但保持与原站一致的调用）
    this.camera.updateMatrixWorld();

    // 采样本帧输入状态（鼠标坐标、是否移动）
    this.input.update();
    // 推进蓝噪声动画（若做了时间偏移）
    this.blueNoise.update();

    // 更新气球：传入帧间隔与指针信息，没有指针时用 active=false 让动画回落
    this.balloons.update(dt, this.input.hasPointer
      ? { x: this.input.mouseXY.x, y: this.input.mouseXY.y, active: true }
      : { x: 0, y: 0, active: false });
    // 背景独立的时间动画（噪声流动 / 渐变呼吸）
    this.background.update(dt);

    // 最后一次绘制：场景 → RenderPass → Final/Smaa/Fsr → 屏幕
    this.composer.render(dt);
  };
}

/** 递归释放场景中的几何体、材质与材质 uniform 里的贴图 */
function disposeObject3D(root) {
  // 遍历自身与所有后代节点
  root.traverse((obj) => {
    // 几何体可选释放（共享几何体会被多次调用 dispose，Three 内部是幂等的）
    obj.geometry?.dispose?.();

    // 材质可能是数组（多材质网格）或单个，统一整理成数组处理
    const materials = Array.isArray(obj.material)
      ? obj.material
      : obj.material ? [obj.material] : [];

    // 逐个材质释放
    for (const material of materials) {
      // 先释放 uniform 中引用的贴图，否则 GPU 上的纹理不会被回收
      for (const uniform of Object.values(material.uniforms || {})) {
        // 取出 uniform 值
        const value = uniform?.value;
        // 只处理真正的纹理对象（用 isTexture 做鸭子类型判断）
        if (value?.isTexture) value.dispose();
      }
      // 最后释放材质本身（着色器程序引用计数递减）
      material.dispose();
    }
  });
}
