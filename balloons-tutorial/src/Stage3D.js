/**
 * Stage3D.js — 3D 场景基类
 *
 * 封装 Three.js 的 Scene + Camera + Renderer 初始化流程，
 * 提供 preInit / init / resize / update 四个子类钩子。
 * HomeBalloons 和 HomeBalloonsBackground 都继承自此类。
 *
 * 子类只需要:
 *  1. 构造函数中先调 super({ cameraFov, defaultCameraPosition, defaultLookAtPosition })
 *  2. 重写 init() 来往 this 里加 Mesh / Light / ShaderMaterial
 *  3. 重写 update(dt) 做每帧逻辑
 *  4. 重写 resize(w, h) 处理屏幕变化
 */

import * as THREE from 'three';

/**
 * Stage3D —— 所有 3D 效果场景的基类（继承自 THREE.Scene）
 *
 * 职责：
 *  1. 统一维护 width / height / time / dt 等公共属性（放在 this.properties 里）
 *  2. 规定生命周期：constructor → preInit() → init() →（每帧）update(dt) →（尺寸变化）resize(w, h)
 *  3. 提供 createRenderer / createPerspectiveCamera 两个开箱即用的工厂方法
 *
 * 注意：构造函数内会立即调用 preInit() / init()，
 * 所以子类不要在 super() 之前访问自己的实例字段；子类字段的赋值要写在 super() 之后。
 */
export class Stage3D extends THREE.Scene {

  /**
   * @param {object} config
   * @param {number} [config.cameraFov=45]                — 透视相机 FOV（度）
   * @param {[number,number,number]} [config.defaultCameraPosition=[0,0,5]]
   * @param {[number,number,number]} [config.defaultLookAtPosition=[0,0,0]]
   * @param {number} [config.clearAlpha=0]               — 渲染器背景 alpha（0=透明）
   * @param {boolean} [config.antialias=true]             — 抗锯齿
   */
  constructor(config = {}) {
    // 先完成 THREE.Scene 的初始化，之后才能往 this 上挂 Object3D / 自定义属性
    super();

    // —— 解构配置项并给全默认值，保证可以无参 new Stage3D() ——
    const {
      cameraFov = 45,
      defaultCameraPosition = [0, 0, 5],
      defaultLookAtPosition = [0, 0, 0],
      clearAlpha = 0,
      antialias = true,
    } = config;

    // —— 公共属性池 ——
    this.properties = {
      width: 1,
      height: 1,
      time: 0,
      dt: 0,
      cameraFov,
      defaultCameraPosition,
      defaultLookAtPosition,
      clearAlpha,
      antialias,
    };
    // 允许外部直接注入 properties（renderer / camera 等）
    // 典型用法：new HomeBalloons({ properties: { renderer } }) —— 复用外部已创建的渲染器，避免重复创建 WebGL context
    if (config.properties) Object.assign(this.properties, config.properties);

    // 子类初始化前钩子
    // 约定：子类在这里创建 renderer / camera / 后处理管线，并挂到 this.properties 上
    this.preInit();

    // 子类初始化主逻辑
    // 约定：子类在这里往 scene 里 add 几何体、灯光、ShaderMaterial
    this.init();
  }

  /**
   * 创建 WebGLRenderer — 可以在 preInit 里覆盖
   * @param {HTMLElement} container
   * @returns {THREE.WebGLRenderer}
   *
   * 参数取值的用意：
   *  - alpha 仅在 clearAlpha === 0 时开启，不需要透明的场景可以省掉一次与页面背景的混合
   *  - premultipliedAlpha = false：与 CSS 背景叠加时边缘不会发灰
   *  - powerPreference = 'high-performance'：双显卡设备上优先使用独显
   *  - setSize 的第三个参数 false：不改写 canvas 的 CSS 尺寸，布局交给外层容器
   */
  static createRenderer(container, clearAlpha = 0, antialias = true) {
    // 1) 创建渲染器：参数尽量贴近原站（透明背景 + 高性能 GPU）

    const renderer = new THREE.WebGLRenderer({
      alpha: clearAlpha === 0,
      antialias,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    // 2) 像素比封顶 2：Retina 屏上按 3x 渲染对气球场景几乎无收益，但像素量翻倍
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    // 3) 用容器的 CSS 尺寸作为绘制尺寸（false 表示不去改写 canvas 的 style）
    renderer.setSize(container.clientWidth, container.clientHeight, false);
    // 4) 输出 sRGB + ACES Filmic 色调映射：高光不会直接烧白，观感接近原站
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    // 5) 把 canvas 挂进容器，由浏览器负责布局
    if (container) container.appendChild(renderer.domElement);
    return renderer;
  }

  // ———————— 子类重写的钩子 ————————

  /** 预初始化钩子 — 在 this 上挂 renderer / camera 等公共对象 */
  preInit() {
    // 默认什么都不做，子类按需 override
  }

  /** 主初始化 — 往 scene 加 Object3D、创建 ShaderMaterial 等 */
  init() {
    // 子类 override
  }

  /**
   * 响应屏幕尺寸变化
   * @param {number} w — 宽度（CSS 像素）
   * @param {number} h — 高度（CSS 像素）
   *
   * 基类只记录尺寸；子类 override 时记得先调用 super.resize(w, h) 或自行同步这两个字段，
   * 再更新 camera.aspect / renderer.setSize / 各 RenderTarget 尺寸。
   */
  resize(w, h) {
    // 缓存到公共属性池，供子类与 shader uniform 复用
    const { properties } = this;
    properties.width = w;
    properties.height = h;
  }

  /**
   * 每帧更新逻辑
   * @param {number} dt — 上一帧到当前帧的时间（秒）
   *
   * 基类只推进时间累加器；子类 override 后应调用 super.update(dt)，
   * 以便 this.properties.time 始终是"场景存活时长"，可直接传给 shader 的 u_time。
   */
  update(dt) {
    // 累加总时长：shader 里所有基于时间的动画都以它为基准
    this.properties.time += dt;
    // 记录本帧步长：物理积分、阻尼系数换算等需要用到
    this.properties.dt = dt;
  }

  // ———————— 工具方法 ————————

  /**
   * 简化的相机创建 — 用构造函数传入的默认参数
   * @returns {THREE.PerspectiveCamera}
   */
  createPerspectiveCamera() {
    const { cameraFov, defaultCameraPosition, defaultLookAtPosition } = this.properties;
    // 宽高比先用 1 占位，真正的 aspect 由子类的 resize() 设置
    // near = 0.01 / far = 1000：覆盖面足够大，气球场景不会出现深度裁剪
    const cam = new THREE.PerspectiveCamera(
      cameraFov, 1, 0.01, 1000
    );
    // 相机位置与朝向都来自构造函数配置，便于不同效果共用同一套基类
    cam.position.set(...defaultCameraPosition);
    cam.lookAt(...defaultLookAtPosition);
    return cam;
  }
}
