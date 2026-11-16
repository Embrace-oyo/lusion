/**
 * HomeBalloonsBackground — 主页背景（1:1 移植自原站 HomeBalloonsBackground）
 *
 * 原站只做两件事：铺满一块近黑色 + 叠一层蓝噪声抖动。
 * 这里保留同样的 uniform 与逻辑，方便后续跟主页其它模块联动。
 */

import * as THREE from 'three';
import { Stage3D } from './Stage3D.js';
import { backgroundVertex, backgroundFragment } from './background.js';

/** 原站背景色：两枚都是 #141515（mix 系数固定 0.925~1.0，肉眼看是纯色） */
const BG_COLOR = '#141515';

export class HomeBalloonsBackground extends Stage3D {

  constructor(config = {}) {
    // 调用 Stage3D 构造：把相机/清屏参数交给基类统一管理
    super({
      // 45° 透视 FOV（背景是纯色，FOV 实际影响不到画面）
      cameraFov: 45,
      // 默认相机放在 z=1（全屏 quad 本身就在 NDC，位置无关）
      defaultCameraPosition: [0, 0, 1],
      // 清屏 alpha = 0，让上层（页面 CSS 背景）透出来
      clearAlpha: 0,
      // 允许外部 config 覆盖上述默认值
      ...config,
    });
  }

  preInit() {
    // 蓝噪声依赖先置空，等 setDependencies 注入
    this.blueNoise = null;
    // 内部累计时间，驱动 shader 的 u_time（可用于噪声动画）
    this._time = 0;
  }

  init() {
    // 背景材质：一个全屏 shader，输出近黑色 + 蓝噪声抖动
    this.material = new THREE.ShaderMaterial({
      // 全屏 pass 共用顶点着色器
      vertexShader: backgroundVertex,
      // 片元着色器负责上色与抖动
      fragmentShader: backgroundFragment,
      uniforms: {
        // 主色（会被气球主题色替换，只占 mix 的小比例）
        u_color0: { value: new THREE.Color(BG_COLOR) },
        // 次色，这里同样是 #141515，保证整体接近纯色
        u_color1: { value: new THREE.Color(BG_COLOR) },
        // 屏幕宽高比，用于把 UV 校正成等比坐标
        u_aspect: { value: 1 },
        // 颜色渐变范围（0~1），mix 系数落在这个区间内
        u_smooth: { value: new THREE.Vector2(0, 1) },
        // 裁剪缩放（用于和页面布局对齐的可选参数）
        u_clipScale: { value: new THREE.Vector2(1, 1) },
        // 裁剪偏移
        u_clipOffset: { value: new THREE.Vector2(0, 0) },
        // 时间（秒）
        u_time: { value: 0 },
        // 蓝噪声纹理，等依赖注入后赋值
        u_blueNoiseTexture: { value: null },
        // 蓝噪声单 texel 尺寸（1/128），shader 里用于采样步长
        u_blueNoiseTexelSize: { value: new THREE.Vector2(1 / 128, 1 / 128) },
        // 蓝噪声采样偏移，每帧同步 BlueNoise.offset，让抖动图案漂移
        u_blueNoiseCoordOffset: { value: new THREE.Vector2(0, 0) },
      },
      // 背景不参与深度测试
      depthTest: false,
      // 也不写深度，避免影响后续物体
      depthWrite: false,
      // 不透明：直接覆盖画面
      transparent: false,
      // 双面渲染，防止三角形绕序导致被剔除
      side: THREE.DoubleSide,
    });

    // 全屏三角形：三个顶点就能盖满整个 NDC
    // 创建空几何体，手动塞 position 属性
    const geo = new THREE.BufferGeometry();
    // 顶点坐标 (-1,-1) (3,-1) (-1,3)：超出 NDC 的三角形，裁剪后正好铺满屏幕
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-1, -1, 0, 3, -1, 0, -1, 3, 0], 3
    ));
    // 用几何体与材质创建网格
    this.mesh = new THREE.Mesh(geo, this.material);
    // 关闭视锥剔除：全屏物体没有可靠的包围盒中心
    this.mesh.frustumCulled = false;
    // 渲染顺序拉到最前（-1000），保证背景最先绘制
    this.mesh.renderOrder = -1000;
    // 加入 Stage3D 的场景
    this.add(this.mesh);
  }

  setDependencies(deps) {
    // 外部注入了蓝噪声系统才处理
    if (deps.blueNoise) {
      // 保存引用，update 里每帧同步偏移
      this.blueNoise = deps.blueNoise;
      // 若纹理已生成（程序化生成是同步的），立即绑定到 uniform
      if (deps.blueNoise.texture) {
        this.material.uniforms.u_blueNoiseTexture.value = deps.blueNoise.texture;
      }
    }
  }

  /** 主题色：原站把 u_color0 设成当前气球主题色（只占 mix 的 7.5%） */
  setThemeColor(color) {
    // 材质已初始化才写入，避免 init 前调用报错
    if (this.material) this.material.uniforms.u_color0.value.set(color);
  }

  resize(w, h) {
    // 交给基类处理相机/渲染器尺寸
    super.resize(w, h);
    // 同步宽高比（高度兜底为 1，避免除零）
    this.material.uniforms.u_aspect.value = w / Math.max(h, 1);
  }

  update(dt) {
    // 基类帧更新（相机矩阵等）
    super.update(dt);
    // 累计时间
    this._time += dt;
    // 写入 shader
    this.material.uniforms.u_time.value = this._time;

    // 有蓝噪声依赖时同步纹理与偏移
    if (this.blueNoise) {
      // 纹理可能在异步加载完成后才就绪，因此每帧检查一次引用是否变化
      if (this.material.uniforms.u_blueNoiseTexture.value !== this.blueNoise.texture) {
        // 重新绑定新纹理
        this.material.uniforms.u_blueNoiseTexture.value = this.blueNoise.texture;
      }
      // 把每帧随机偏移同步给 shader，让抖动图案漂移
      this.material.uniforms.u_blueNoiseCoordOffset.value.copy(this.blueNoise.offset);
    }
  }
}
