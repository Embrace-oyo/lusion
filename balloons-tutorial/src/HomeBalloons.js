/**
 * HomeBalloons — 主页气球主体（1:1 移植自原站 HomeBalloons）
 *
 * 结构:
 *   - 22 个 Mesh（几何体 cross.buf，半径 = 1）
 *   - 每个 Mesh 一套 ShaderMaterial，uniform 里带 21 个邻居的位置/旋转/颜色
 *   - 物理每帧驱动 transform，排序每帧重算最近邻
 *   - 相机 FOV 25，位于 (0, 0, 17.5)，看向原点（开场有 dolly zoom）
 */

import * as THREE from 'three';
import { Stage3D } from './Stage3D.js';
import { HomeBalloonsPhysics } from './HomeBalloonsPhysics.js';
import { balloonVertex, balloonFragment } from './balloon.js';
import { loadBuf } from './BufLoader.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { BALLOON_COLORS, makeSphereData, CAMERA } from './lusionData.js';

/** 22 个气球 → 每个球能看到其余 21 个 */
// 气球总数（与原站一致，硬编码进 shader define）
const NUM_BALLOONS = 22;
// 每颗球需要收集的邻居数量 = 总数 - 自己
const NEIGHBOUR_COUNT = NUM_BALLOONS - 1;

/** 从原站 bundle 提取的精确配置 */
// 用首个主题色生成 22 颗球的半径/颜色/材质参数等静态数据
const SPHERES_DATA = makeSphereData(BALLOON_COLORS[0]);

export class HomeBalloons extends Stage3D {

  constructor(config = {}) {
    // 交给 Stage3D 建立相机与渲染环境
    super({
      // 原站相机 FOV 25（长焦，压缩透视让球簇更"平"）
      cameraFov: CAMERA.FOV,
      // 相机初始位置 (0,0,17.5)
      defaultCameraPosition: [0, 0, 17.5],
      // 看向原点（球簇中心）
      defaultLookAtPosition: [0, 0, 0],
      // 清屏 alpha = 0，让背景层/页面透出
      clearAlpha: 0,
      // 外部 config 可覆盖默认值
      ...config,
    });
  }

  // ———————————— 初始化 ————————————

  preInit() {
    // renderer 由外部依赖注入（Stage3D 内部也会用）
    this.renderer = this.properties.renderer || null;
    // 物理系统实例，但还没建 body（等 init 里 initWorld）
    this.physics = new HomeBalloonsPhysics();

    // 蓝噪声依赖，先置空
    this.blueNoise = null;
    // 22 个 Mesh
    this.meshes = [];
    // 22 个材质
    this.materials = [];
    // 共享几何体（会先放兜底几何，再被 cross.buf 替换）
    this.geometry = null;

    // 当前主题色索引
    this.colorIndex = 0;
    // 黑白模式开关（部分球在 #888 / #eee 之间切换）
    this.blackWhiteToggle = false;
  }

  init() {
    // 创建透视相机（参数来自构造时的 cameraFov 等）
    this.camera = this.createPerspectiveCamera();
    // 相机看向原点；origin 位于球簇中心
    // 固定相机位置，避免基类默认值差异
    this.camera.position.set(0, 0, 17.5);
    // 朝原点看
    this.camera.lookAt(0, 0, 0);
    // 立刻更新世界矩阵，保证首帧 raycast / unproject 正确
    this.camera.updateMatrixWorld();

    // 先建兜底几何体（cross.buf 异步加载完成后会替换）
    this._createGeometry();
    // 创建 22 个气球 Mesh 与材质
    this._createBalloons();
    // 依据球数据创建物理体（顺序与 meshes 一一对应）
    this.physics.initWorld(SPHERES_DATA);
    // 异步加载原站资源（几何体 + matcap）
    this._loadAssets();
  }

  /**
   * 兜底几何体：在 cross.buf 到达前也能渲染。
   * 手动补齐 shader 需要的 daoN / daoP / SN / ao，否则会全黑。
   */
  _createGeometry() {
    // 用 3 级细分的二十面体球当兜底（顶点数够多，形变起来不破面）
    const geo = new THREE.IcosahedronGeometry(1, 3);
    // 原始法线属性
    const normal = geo.attributes.normal;
    // daoN：外站 shader 里的法线辅助属性，兜底直接用 normal 复制一份
    geo.setAttribute('daoN', normal.clone());
    // daoP：位置辅助属性（用于自定义形变/视差），这里同样用 normal 占位
    geo.setAttribute('daoP', normal.clone());
    // SN：球面法线，供 shader 的法线混合使用
    geo.setAttribute('SN', normal.clone());
    // ao：环境光遮蔽，全填 1（无遮蔽），否则未赋值会导致全黑
    geo.setAttribute('ao', new THREE.BufferAttribute(new Float32Array(normal.count).fill(1), 1));
    // 保存为当前共享几何体
    this.geometry = geo;
  }

  _createBalloons() {
    // 逐个创建气球
    for (let i = 0; i < NUM_BALLOONS; i++) {
      // 该球的静态配置
      const data = SPHERES_DATA[i];
      // 每颗球独立材质（uniform 里要存自己的 21 个邻居数据，不能共享）
      const mat = this._createMaterial(data);
      // 共享同一个几何体，靠 scale 表现不同半径
      const mesh = new THREE.Mesh(this.geometry, mat);
      // 缩放成该球半径
      mesh.scale.setScalar(data.radius);
      // 关闭视锥剔除：球会被物理推到画面边缘，包围盒判断可能失效
      mesh.frustumCulled = false;
      // 渲染顺序按索引，配合深度测试决定半透明球的叠放
      mesh.renderOrder = i;

      // 取自身位置/半径 uniform
      const selfPosRadius = mat.uniforms.u_selfPositionRadius.value;
      // 写入 w 分量 = 半径（xyz 每帧由物理同步）
      selfPosRadius.w = data.radius;

      // 收集材质
      this.materials.push(mat);
      // 收集 Mesh
      this.meshes.push(mesh);
      // 加入 Stage3D 场景
      this.add(mesh);
    }
    // 初始位置交给物理系统（第一帧就会覆盖）
    // 先同步一次，避免首帧 mesh 全在原点
    this._syncTransforms();
  }

  _createMaterial(data) {
    // 邻居位置+半径（vec4）
    const nearPos = [];
    // 邻居朝向
    const nearRot = [];
    // 邻居颜色
    const nearColor = [];
    // 邻居两个标量：是否半透明、亮度
    const nearLuma = [];
    // 为 21 个邻居预先分配 uniform 对象（避免每帧 new 造成 GC）
    for (let i = 0; i < NEIGHBOUR_COUNT; i++) {
      // xyz = 位置，w = 半径
      nearPos.push(new THREE.Vector4());
      // 旋转四元数
      nearRot.push(new THREE.Quaternion());
      // 颜色
      nearColor.push(new THREE.Color());
      // x = 是否半透明，y = 亮度
      nearLuma.push(new THREE.Vector2());
    }

    return new THREE.ShaderMaterial({
      // 气球专用光照/形变顶点着色器
      vertexShader: balloonVertex,
      // 片元着色器（matcap + 圆角裁剪 + 抖动）
      fragmentShader: balloonFragment,
      // 把邻居数量编译成常量，shader 里可直接 for 循环
      defines: { NEIGHBOUR_COUNT },
      uniforms: {
        // 自身主题色
        u_color:           { value: new THREE.Color(data.color) },
        // matcap 环境贴图（异步加载后填入）
        u_matcap:          { value: null },
        // 主光位置（世界空间）
        u_lightPosition:   { value: new THREE.Vector3(10, 10, 5) },
        // 粗糙度：粗糙球 0.8，光滑球 0.1（影响高光锐利度）
        u_roughness:       { value: data.isRough ? 0.8 : 0.1 },
        // 自身位置 + 半径（w 分量）
        u_selfPositionRadius: { value: new THREE.Vector4(0, 0, 0, data.radius) },
        // 自身朝向
        u_selfRotation:    { value: new THREE.Quaternion() },

        // 21 个邻居的四组 uniform 数组
        u_nearPositionRadiusList:  { value: nearPos },
        u_nearRotationList:        { value: nearRot },
        u_nearColorList:           { value: nearColor },
        u_nearTransparencyLumaList:{ value: nearLuma },

        // 蓝噪声纹理（用于圆角边缘抖动）
        u_blueNoiseTexture:   { value: null },
        // 蓝噪声 texel 尺寸（默认 128×128）
        u_blueNoiseTexelSize: { value: new THREE.Vector2(1 / 128, 1 / 128) },
        // 蓝噪声采样偏移（每帧同步，打散固定抖动图案）
        u_blueNoiseCoordOffset: { value: new THREE.Vector2(0, 0) },
      },
      // 开启导数扩展：shader 里用 dFdx/dFdy 做屏幕空间法线或边缘判断
      extensions: { derivatives: true },
      // 不透明：靠深度测试处理遮挡
      transparent: false,
      // 开启深度测试
      depthTest: true,
      // 写入深度，让球之间正确遮挡
      depthWrite: true,
      // 只渲染正面（球体不需要背面）
      side: THREE.FrontSide,
    });
  }

  /** 异步加载原站资源：cross.buf 几何体 + matcap.exr */
  _loadAssets() {
    // 加载二进制几何体（cross.buf 是原站导出的自定义格式）
    loadBuf('/assets/models/home/cross.buf')
      .then((geo) => {
        // 替换共享几何体
        this.geometry = geo;
        // 所有 mesh 指向新几何体（原地替换，不重建材质）
        for (const mesh of this.meshes) mesh.geometry = geo;
        // 打印顶点数与属性名，便于确认二进制解析正确
        console.log(
          `[HomeBalloons] cross.buf 已接入 — 顶点 ${geo.attributes.position.count}` +
          ` · 属性 ${Object.keys(geo.attributes).join(',')}`
        );
      })
      .catch((err) => console.warn('[HomeBalloons] cross.buf 加载失败:', err.message));

    // 加载 matcap 环境贴图（EXR 浮点，保留高光动态范围）
    new EXRLoader().load(
      '/assets/textures/home/matcap.exr',
      (tex) => {
        // 线性过滤：matcap 需要平滑插值
        tex.minFilter = THREE.LinearFilter;
        // 放大同样线性
        tex.magFilter = THREE.LinearFilter;
        // 线性色彩空间：EXR 本身是线性数据，不能再做 sRGB 转换
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        // 给所有材质绑定同一张贴图
        for (const mat of this.materials) mat.uniforms.u_matcap.value = tex;
        // 加载成功日志
        console.log('[HomeBalloons] matcap.exr 已接入');
      },
      undefined,
      (err) => console.warn('[HomeBalloons] matcap.exr 加载失败:', err)
    );
  }

  setDependencies(deps) {
    // 渲染器依赖：同时更新 Stage3D 内部属性，保证基类也拿到
    if (deps.renderer) {
      this.renderer = deps.renderer;
      this.properties.renderer = deps.renderer;
    }
    // 蓝噪声依赖：保存并立即注入到所有材质
    if (deps.blueNoise) {
      this.blueNoise = deps.blueNoise;
      this._injectBlueNoise();
    }
  }

  _injectBlueNoise() {
    // 依赖或纹理还没就绪则跳过（纹理可能是异步加载的）
    if (!this.blueNoise || !this.blueNoise.texture) return;
    // 已注入过同一张纹理就不重复写入
    if (this._injectedBlueNoise === this.blueNoise.texture) return;
    // 记录当前已注入的纹理引用
    this._injectedBlueNoise = this.blueNoise.texture;
    // 逐材质绑定纹理
    for (const m of this.materials) {
      m.uniforms.u_blueNoiseTexture.value = this.blueNoise.texture;
    }
  }

  // ———————————— resize ————————————

  resize(w, h) {
    // 基类处理渲染器/相机基础尺寸
    super.resize(w, h);
    // 同步相机宽高比（高度兜底 1，避免除零）
    this.camera.aspect = w / Math.max(h, 1);
    // 更新投影矩阵，保证画面不变形
    this.camera.updateProjectionMatrix();
  }

  // ———————————— update ————————————

  /**
   * @param {number} dt
   * @param {{x:number,y:number}} mouseXY — NDC 鼠标坐标
   */
  update(dt, mouseXY = { x: 0, y: 0 }) {
    // 基类帧更新（相机矩阵等）
    super.update(dt);

    // 每帧尝试注入蓝噪声（等异步纹理就绪后自动生效）
    this._injectBlueNoise();

    // 原站是 60fps 定步长模拟；这里用固定步长重放，避免变帧率把气球簇甩出画面
    // _acc 累积真实帧时间（首次调用时初始化 0）
    this._acc = (this._acc || 0) + dt;
    // 固定步长 1/60 秒
    const STEP = 1 / 60;
    // 本帧已执行的物理步数
    let steps = 0;
    // 累加时间够一步就跑一步，最多 4 步防止卡顿后"追帧"雪崩
    while (this._acc >= STEP && steps < 4) {
      // 用固定步长推进物理（与真实 dt 解耦，保证模拟稳定）
      this.physics.update(STEP, this.camera, mouseXY);
      // 消耗已模拟的时间
      this._acc -= STEP;
      // 计数
      steps++;
    }
    // 跑满 4 步说明严重掉帧，直接丢弃剩余累积时间，避免持续追赶
    if (steps === 4) this._acc = 0;

    // 物理结果写回 mesh 与自身 uniform
    this._syncTransforms();
    // 重新计算每颗球的 21 个最近邻
    this._updateSorting();
    // 刷新主题色（含黑白切换）
    this._updateColors();

    // 蓝噪声偏移每帧漂移，避免抖动图案固定
    if (this.blueNoise) {
      // 所有材质共享同一个偏移值
      for (const m of this.materials) {
        m.uniforms.u_blueNoiseCoordOffset.value.copy(this.blueNoise.offset);
      }
    }
  }

  /** 物理体 → mesh + u_selfPositionRadius */
  _syncTransforms() {
    // 逐个同步（编号与物理体索引一一对应）
    for (let i = 0; i < NUM_BALLOONS; i++) {
      // 第 i 个物理体
      const body = this.physics.bodies[i];
      // 第 i 个 mesh
      const mesh = this.meshes[i];
      // 任一缺失则跳过（首次同步时物理体可能还未建完）
      if (!body || !mesh) continue;
      // 位置：物理体 → mesh
      mesh.position.copy(body.position);
      // 朝向：物理体 → mesh
      mesh.quaternion.copy(body.quaternion);

      // 对应材质
      const mat = this.materials[i];
      // 取自身位置/半径 uniform
      const sp = mat.uniforms.u_selfPositionRadius.value;
      // xyz 写位置，w 写该球数据里的原始半径（shader 用它做邻居间距计算）
      sp.set(body.position.x, body.position.y, body.position.z, SPHERES_DATA[i].radius);
      // 朝向 uniform 直接指向物理体的四元数对象（每帧复用，避免拷贝）
      mat.uniforms.u_selfRotation.value = body.quaternion;
    }
  }

  /** 每帧为每个球找最近的 21 个邻居，写入 uniform 数组 */
  _updateSorting() {
    // 首次调用时分配一个可复用的排序数组（长度 = 球数）
    if (!this._sorted) {
      this._sorted = this.meshes.map((_, i) => ({ index: i, distance2: 0 }));
    }
    // 短引用
    const list = this._sorted;

    // 为每颗球独立计算邻居列表
    for (let i = 0; i < NUM_BALLOONS; i++) {
      // 当前球的材质
      const mat = this.materials[i];
      // 当前球的世界位置
      const selfPos = this.meshes[i].position;

      // 填充距离表：自己距离记 0，其余用距离平方（省一次开方）
      for (let j = 0; j < NUM_BALLOONS; j++) {
        // 记录原始索引，排序后仍能找到对应 mesh/材质
        list[j].index = j;
        // 距离平方（自己为 0 → 排序后固定在最前）
        list[j].distance2 = j === i ? 0 : selfPos.distanceToSquared(this.meshes[j].position);
      }
      // 升序排序，前 NEIGHBOUR_COUNT+1 项即"最近的 21 个 + 自己"
      list.sort((a, b) => a.distance2 - b.distance2);

      // 四组邻居 uniform 数组
      const posList = mat.uniforms.u_nearPositionRadiusList.value;
      const rotList = mat.uniforms.u_nearRotationList.value;
      const colList = mat.uniforms.u_nearColorList.value;
      const lumaList = mat.uniforms.u_nearTransparencyLumaList.value;

      // 取前 21 个邻居（跳过 list[0] 自己）
      for (let r = 0; r < NEIGHBOUR_COUNT; r++) {
        // 邻居在排序表里的条目
        const nb = list[r + 1];
        // 邻居 mesh
        const nbMesh = this.meshes[nb.index];
        // 邻居静态数据
        const nbData = SPHERES_DATA[nb.index];
        // 邻居当前颜色（可能是主题色，会随换色变化）
        const color = this.materials[nb.index].uniforms.u_color.value;

        // 位置 + 半径（w = mesh 缩放即半径）
        posList[r].set(nbMesh.position.x, nbMesh.position.y, nbMesh.position.z, nbMesh.scale.x);
        // 朝向
        rotList[r].copy(nbMesh.quaternion);
        // 颜色
        colList[r].copy(color);
        // 第一个分量：是否半透明（shader 里用于柔化接触/叠加）
        // 第二个分量：感知亮度（Rec.601 权重），用于透明度与色调适配
        lumaList[r].set(
          nbData.isSemitransparent ? 1 : 0,
          color.r * 0.299 + color.g * 0.587 + color.b * 0.114
        );
      }
    }
  }

  /** 主题色轮换：只有 isColored 的球会变色 */
  _updateColors() {
    // 当前主题色
    const hex = BALLOON_COLORS[this.colorIndex];
    // 逐球更新
    for (let i = 0; i < NUM_BALLOONS; i++) {
      // 该球静态配置
      const data = SPHERES_DATA[i];
      // 该球颜色 uniform（Color 对象原地修改，不重建）
      const uColor = this.materials[i].uniforms.u_color.value;
      // 参与主题色的球直接使用当前主题色
      if (data.isColored) {
        uColor.set(hex);
      } else if (data.isBlackWhite) {
        // 黑白球在两种灰之间切换（营造闪烁/交替效果）
        uColor.set(this.blackWhiteToggle ? '#888' : '#eee');
      }
    }
  }

  /** 当前主题色（背景/页面其它元素要跟着变） */
  currentColorHex() {
    // 返回当前索引对应的十六进制色值
    return BALLOON_COLORS[this.colorIndex];
  }

  /** 点击/换色：切主题色 + 给所有球一次脉冲（原站行为） */
  nextColor() {
    // 循环切到下一个主题色
    this.colorIndex = (this.colorIndex + 1) % BALLOON_COLORS.length;
    // 黑白开关取反
    this.blackWhiteToggle = !this.blackWhiteToggle;
    // 所有物理体来一次爆炸脉冲，视觉上球簇"炸开"再重新汇聚
    for (const b of this.physics.bodies) b.applyImpulse();
  }
}
