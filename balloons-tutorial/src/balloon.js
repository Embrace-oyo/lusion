/**
 * balloon.js — 气球 Shader（1:1 移植自 lusion.co 线上 bundle 的 vert$l / frag$p）
 *
 * 与线上完全一致的要点:
 *   1. 顶点阶段用烘焙好的 daoN / daoP / SN / ao 四个属性重新计算"自阴影"
 *   2. 片元阶段对 21 个邻居球做射线-十字体相交:
 *        - 遮挡 AO（getCrossAoShadowIntersect 里的三轴胶囊 AO）
 *        - 阴影 shadow
 *        - GI（邻居颜色渗透）
 *        - reflections（沿反射方向打三个圆柱求最近命中 → 气球互相映出彼此）
 *   3. matcap 三通道分离: r → diffuse / g(rough) 或 b(smooth) → specular
 *   4. 末尾 filmicToneMapping(pow(color, 2.2))
 *
 * 注意: 主页的 22 个气球全部不透明，因此这里只保留 IS_SEMITRANSPARENT 之外的
 * 那条分支（原站用 #ifdef 分叉），避免多余的 textureBicubic 依赖。
 */

// ============================================================
// 顶点着色器
// ============================================================

/**
 * 气球顶点着色器。
 *
 * 原站把「每个顶点受到的邻居遮蔽」离线烘进了 4 个属性：
 *   daoN / daoP —— 沿法线/切线两个半球的 AO 方向（三轴胶囊形状），
 *   SN          —— 平滑法线，ao —— 顶点级 AO。
 * 运行时只需把光照方向转到气球本地空间（因为气球在滚动，烘焙数据是跟着物体转的），
 * 在 daoN / daoP 之间按光照方向的符号混合，即可得到逐顶点的自阴影。
 *
 * 调用方：气球主材质（Balloon），每个气球一次 instanced/单实例绘制。
 */
export const balloonVertex = /* glsl */`
  // 沿法线半球的 AO（三轴胶囊）
  attribute vec3  daoN;   // 沿法线半球的 AO（三轴胶囊）
  // 沿切线半球的 AO（正面/背面两个半球各烘一份）
  attribute vec3  daoP;   // 沿切线半球的 AO
  // 平滑法线：用于 matcap 采样与阴影插值，避免硬边
  attribute vec3  SN;     // 平滑法线（用于 matcap / 阴影）
  // 顶点级烘焙 AO（0~1）
  attribute float ao;     // 顶点烘焙 AO

  // 场景主光源位置（世界空间）
  uniform vec3  u_lightPosition;
  // 本球世界位置（xyz）与半径（w）
  uniform vec4  u_selfPositionRadius;  // xyz = 自身世界位置, w = 半径
  // 本球当前朝向四元数
  uniform vec4  u_selfRotation;        // 自身四元数

  // 相机空间位置（= -mvPosition，指向相机）
  varying vec3  v_viewPosition;
  // 世界空间位置
  varying vec3  v_worldPosition;
  // 相机空间法线
  varying vec3  v_viewNormal;
  // 相机空间平滑法线
  varying vec3  v_smoothViewNormal;
  // 烘焙 AO
  varying float v_ao;
  // 逐顶点自阴影系数
  varying float v_selfShadow;

  /** 用四元数 q 旋转向量 v（q 需为规范化四元数） */
  vec3 qrotate(vec3 v, vec4 q) {
    // 等价于 v + 2 * cross(q.xyz, cross(q.xyz, v) + q.w * v)，展开后即 q·v·q⁻¹
    return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  void main() {
    // 本地顶点 → 相机空间
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.);
    // 投影到裁剪空间
    gl_Position = projectionMatrix * mvPosition;

    // 本地顶点 → 世界空间
    vec3 worldPosition = (modelMatrix * vec4(position, 1.)).xyz;

    // 光照方向转到物体本地空间（气球整体在滚，AO 是跟着物体一起转的）
    // 四元数的共轭 = 逆旋转（单位四元数），用来把世界方向转回物体空间
    vec4 invertedQuat = vec4(-u_selfRotation.xyz, u_selfRotation.w);
    // 先求世界空间指向光源的向量，再除以半径做归一化尺度（让 AO 的梯度以「球半径」为单位）
    vec3 L = (u_lightPosition - worldPosition) / u_selfPositionRadius.w;
    // 旋转到本地空间并归一化，得到单位光照方向
    L = normalize(qrotate(L, invertedQuat));

    // 按光照方向在正/负半球之间混合两个烘焙 AO 方向
    // sign(L) ∈ {-1,0,1} → 映射到 {0,0.5,1}，作为 mix 权重选半球
    vec3 dao = mix(daoN, daoP, sign(L) * .5 + .5);
    // 取光照方向三个分量的绝对值，作为沿三个轴的权重
    vec3 absDir = abs(L);
    // 以 L1 归一化的方式对三轴 AO 做加权平均（分母即 |x|+|y|+|z|）
    float selfShadow = dot(absDir, dao) / (absDir.x + absDir.y + absDir.z);
    // 对比度曲线：*3 提高动态范围，pow(...,0.3) 是 gamma 0.3，会明显提亮暗部，再 *1.45 放大并截断到 1
    selfShadow = min(pow(selfShadow * 3., 0.3) * 1.45, 1.);

    // 传给片元：世界位置
    v_worldPosition    = worldPosition;
    // 普通法线转到相机空间
    v_viewNormal       = normalMatrix * normal;
    // 平滑法线转到相机空间
    v_smoothViewNormal = normalMatrix * SN;
    // 取反的相机空间位置，即「从表面指向相机」的向量
    v_viewPosition     = -mvPosition.xyz;
    // 透传烘焙 AO
    v_ao               = ao;
    // 透传自阴影
    v_selfShadow       = selfShadow;
  }
`;

// ============================================================
// 片元着色器
// ============================================================

/**
 * 气球片元着色器。
 *
 * 着色流程（与原站一致）：
 *   1. 用蓝噪声扰动的反射方向，对 21 个邻居气球做「十字胶囊」求交；
 *   2. 求交结果拆成三个通道：AO、阴影、最近反射距离；
 *   3. 邻居颜色以 GI 的形式叠加（颜色渗透）；
 *   4. matcap 三通道分离：r → 漫反射，g/b → 高光（按粗糙度二选一）；
 *   5. 合成后做 pow(color, 2.2) 解码 + filmic 色调映射。
 *
 * 调用方：气球主材质（Balloon），与 balloonVertex 配套。
 */
export const balloonFragment = /* glsl */`
  // 相机空间法线
  varying vec3  v_viewNormal;
  // 相机空间平滑法线
  varying vec3  v_smoothViewNormal;
  // 相机空间位置（指向相机）
  varying vec3  v_viewPosition;
  // 世界空间位置
  varying vec3  v_worldPosition;
  // 烘焙 AO
  varying float v_ao;
  // 顶点级自阴影
  varying float v_selfShadow;

  // 邻居：位置 + 半径
  uniform vec4  u_nearPositionRadiusList[NEIGHBOUR_COUNT];   // xyz 位置, w 半径
  // 邻居：旋转四元数
  uniform vec4  u_nearRotationList[NEIGHBOUR_COUNT];         // 邻居四元数
  // 邻居：颜色（用于 GI 与反射着色）
  uniform vec3  u_nearColorList[NEIGHBOUR_COUNT];            // 邻居颜色
  // 邻居：x = 半透明程度，y = 亮度
  uniform vec2  u_nearTransparencyLumaList[NEIGHBOUR_COUNT]; // x 半透明, y 亮度
  // 本球基础粗糙度（会叠加屏幕空间法线变化）
  uniform float u_roughness;
  // 本球颜色
  uniform vec3  u_color;
  // 场景主光源位置
  uniform vec3  u_lightPosition;
  // matcap 贴图：r=漫反射，g=粗糙高光，b=光滑高光
  uniform sampler2D u_matcap;

  // 蓝噪声贴图与采样参数（用于抖动粗糙反射）
  uniform sampler2D u_blueNoiseTexture;
  // 蓝噪声 1/分辨率
  uniform vec2      u_blueNoiseTexelSize;
  // 蓝噪声采样偏移
  uniform vec2      u_blueNoiseCoordOffset;

  // 圆周率，用于角度/球面坐标换算
  const float PI = 3.14159265359;
  // 1/π，用于 Lambert 漫反射归一化
  const float RECIPROCAL_PI = 0.31830988618;

  // saturate 宏：把值截断到 [0,1]（部分平台没有内置 saturate）
  #ifndef saturate
  #define saturate( a ) clamp( a, 0.0, 1.0 )
  #endif

  // —— getBlueNoise chunk（原站 shaderHelper.addChunk 注入的那段）——
  /** 按像素坐标采样蓝噪声 */
  vec3 getBlueNoise(vec2 coord) {
    // 像素坐标 → UV（乘 texelSize），再加偏移
    return texture2D(u_blueNoiseTexture, coord * u_blueNoiseTexelSize + u_blueNoiseCoordOffset).rgb;
  }

  /** 四元数旋转向量（与顶点着色器同一实现） */
  vec3 qrotate(vec3 v, vec4 q) {
    // 标准 q v q⁻¹ 展开式
    return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }

  /** 射线 (ro, rd) 与线段 a-b 为轴的圆柱（半径 ra）求交，返回最近 t */
  float cylIntersect(in vec3 ro, in vec3 rd, in vec3 a, in vec3 b, float ra) {
    // 圆柱轴向量
    vec3 ba = b - a;
    // 射线起点相对圆柱底端的位置
    vec3 oc = ro - a;
    // |ba|²，二次方程里反复用到
    float baba = dot(ba, ba);
    // ba 与射线方向的点积
    float bard = dot(ba, rd);
    // ba 与 oc 的点积
    float baoc = dot(ba, oc);
    // 二次项系数（射线方向去掉沿轴分量后的长度²）
    float k2 = baba - bard * bard;
    // 一次项系数
    float k1 = baba * dot(oc, rd) - baoc * bard;
    // 常数项（含半径项 -ra²·|ba|²）
    float k0 = baba * dot(oc, oc) - baoc * baoc - ra * ra * baba;
    // 判别式
    float h = k1 * k1 - k2 * k0;
    // 有实根才可能相交
    if (h >= 0.) {
      // 判别式开方
      h = sqrt(h);
      // 取较近的根（侧面交点）
      float t = (-k1 - h) / k2;
      // 交点在轴上的投影长度（0~baba 表示落在圆柱侧面内）
      float y = baoc + t * bard;
      // 落在有限长侧面内 → 有效
      if (y > 0.0 && y < baba) return t;
      // 否则求与端盖平面的交点（y<0 取底端，否则取顶端）
      t = (((y < 0.0) ? 0.0 : baba) - baoc) / bard;
      // 端盖交点必须落在圆盘半径内（|k1+k2t| < h 等价于径向距离 < ra）
      if (abs(k1 + k2 * t) < h) {
        // 端盖命中
        return t;
      }
    }
    // 未命中返回一个大距离（200 作为“无穷远”哨兵值）
    return 200.;
  }

  /** 射线是否与半径 r、球心在原点的球相交（只做布尔判断） */
  bool centerSphereHitTest(in vec3 ro, in vec3 rd, in float r) {
    // 二次方程 b t² + 2b t + c 形式：b = ro·rd，c = |ro|² - r²
    float b = dot(ro, rd);
    // 常数项
    float c = dot(ro, ro) - r * r;
    // 判别式 b² - c >= 0 即相交（rd 已归一化，二次项系数为 1）
    return b * b - c >= 0.0;
  }

  /**
   * 核心：把邻居气球当成"十字体"（三根正交胶囊）来算
   *   .x = AO   .y = shadow   .z = 反射最近命中距离
   */
  vec3 getCrossAoShadowIntersect(
    in vec3 p, in vec3 n, in vec3 l, in vec3 refl,
    in vec4 objPosRadius, in vec4 quaternion, in float intersectDist
  ) {
    // AO 初值 1（无遮蔽）
    float ao = 1.0;
    // 阴影初值 1（完全受光）
    float shadow = 1.0;
    // 反射命中距离初值 100（视为未命中）
    float intersect = 100.0;
    // 胶囊半长 R = 2/3 半径：三根胶囊拼出一个近似的球
    float R = 0.666667 * objPosRadius.w;
    // 胶囊粗细 r = 1/3 半径
    float r = 0.333333 * objPosRadius.w;
    // 邻居球心世界坐标
    vec3 centerPos = objPosRadius.xyz;
    // 平移到邻居本地空间所需的偏移（取反）
    vec3 invertedPosOffset = -objPosRadius.xyz;
    // 邻居旋转的共轭四元数（世界 → 邻居本地）
    vec4 invertedQuat = vec4(-quaternion.xyz, quaternion.w);

    // 把着色点、光方向、法线、反射方向全部转到邻居的本地空间
    // 位置：先平移到邻居中心为原点，再逆旋转
    p = qrotate(p + invertedPosOffset, invertedQuat);
    // 光方向同样平移+逆旋转（平移会改变方向，原站就是这么近似的）
    l = normalize(qrotate(l + invertedPosOffset, invertedQuat));
    // 法线只做逆旋转（方向量不需要平移）
    n = qrotate(n, invertedQuat);
    // 反射方向只做逆旋转
    refl = qrotate(refl, invertedQuat);

    // 胶囊轴的起点/终点：从 (-R,-R,-R) 到 (R,R,R)
    vec3 ro = p, pa = vec3(-R), pb = vec3(R);
    // 阴影软硬系数 k（1 = 软过渡基准）
    float k = 1.;
    // 轴向量
    vec3 ba = pb - pa;
    // 起点相对胶囊底端的向量
    vec3 oa = ro - pa;

    // —— 三轴胶囊 AO ——
    // 把着色点分别投影到 X/Y/Z 三根胶囊的局部平面（其余分量清零/保留）
    vec3 oaX = vec3(oa.x, ro.y, ro.z);
    // Y 轴胶囊的对应点
    vec3 oaY = vec3(ro.x, oa.y, ro.z);
    // Z 轴胶囊的对应点
    vec3 oaZ = vec3(ro.x, ro.y, oa.z);
    // 轴向长度的平方（三个轴相同）
    vec3 baba = ba * ba;
    // oa 在轴上的投影（含符号）
    vec3 oaba = oa * ba;
    // 把投影参数 clamp 到 [0,1]，得到轴上的最近点比例
    vec3 h3 = clamp(oaba / baba, vec3(0.), vec3(1.));
    // 各轴：轴上的最近点 → 着色点的距离向量（只保留垂直于该轴的分量）
    vec3 odX = oaX - vec3(h3.x * ba.x, 0., 0.);
    // Y 轴的距离向量
    vec3 odY = oaY - vec3(0., h3.y * ba.y, 0.);
    // Z 轴的距离向量
    vec3 odZ = oaZ - vec3(0., 0., h3.z * ba.z);
    // 三根胶囊的距离长度
    vec3 dl3 = vec3(length(odX), length(odY), length(odZ));
    // 胶囊 AO 公式：r²/(d³) 乘以方向余弦，1 - 该项后 clamp（iq 的球体 AO 推广到三轴）
    vec3 o3 = vec3(1.) - saturate(vec3(dot(-odX, n), dot(-odY, n), dot(-odZ, n)) * r * r / (dl3 * dl3 * dl3));
    // 取三次方再开方（即对 1-x 做“立方”形衰减），让遮蔽更集中在贴近处
    o3 = sqrt(o3 * o3 * o3);
    // 三轴 AO 相乘（近似三次遮挡叠加）
    ao = o3.x * o3.y * o3.z;

    // —— 三轴胶囊阴影 ——
    // 三个轴方向上，oa 与光方向 l 的点积
    vec3 oad = vec3(dot(oaX, l), dot(oaY, l), dot(oaZ, l));
    // 光方向在轴上的投影
    vec3 dba = l * ba;
    // 求解交点参数时公用的分母（避免重复除法，且防止除零用 max 限制）
    vec3 thDiv = 1. / (baba - dba * dba);
    // t：射线进入胶囊的距离参数（下限 0.0001 防负值）
    vec3 thX3 = max((-oad * baba + dba * oaba) * thDiv, vec3(0.0001));
    // t：最近点沿轴的参数（clamp 到 0~1）
    vec3 thY3 = saturate((oaba - oad * dba) * thDiv);
    // 轴上的最近点位置
    vec3 pp = pa + ba * thY3;
    // 三条射线上与轴最近的点（分别沿 X/Y/Z）
    vec3 qqX = ro + l * thX3.x;
    vec3 qqY = ro + l * thX3.y;
    vec3 qqZ = ro + l * thX3.z;
    // 三轴到胶囊表面的有符号距离（减去半径 r）
    vec3 dd = vec3(
      length(vec3(pp.x, 0., 0.) - qqX),
      length(vec3(0., pp.y, 0.) - qqY),
      length(vec3(0., 0., pp.z) - qqZ)
    ) - r;
    // 距离 → 阴影系数：k*dd/t + 0.5 再截断，t 越大（越远）过渡越软
    vec3 s = saturate(k * dd / thX3 + 0.5);
    // smoothstep 式软化（3s²-2s³）
    s = s * s * (3.0 - 2.0 * s);
    // 三轴阴影相乘
    shadow = s.x * s.y * s.z;

    // —— 沿反射方向与三根圆柱求交（气球互相映照）——
    // 圆柱端点声明
    vec3 a;
    vec3 b;
    // 反射用圆柱略细一点，避免与 AO/阴影的胶囊完全重合产生硬边
    r *= 0.9;
    // 提前剔除：如果邻居已经远到不可能影响反射，且反射射线没有打中其包围球，就跳过
    if ((intersectDist + 2.05 > length(p) - objPosRadius.w) && centerSphereHitTest(ro, refl, objPosRadius.w * 1.1)) {
      // X 轴圆柱
      a = vec3(-objPosRadius.w, 0.0, 0.0);
      b = vec3(objPosRadius.w, 0.0, 0.0);
      // 取最近的命中距离
      intersect = min(intersect, cylIntersect(p, refl, a, b, r));

      // Y 轴圆柱
      a = vec3(0.0, -objPosRadius.w, 0.0);
      b = vec3(0.0, objPosRadius.w, 0.0);
      // 更新最近距离
      intersect = min(intersect, cylIntersect(p, refl, a, b, r));

      // Z 轴圆柱
      a = vec3(0.0, 0.0, -objPosRadius.w);
      b = vec3(0.0, 0.0, objPosRadius.w);
      // 更新最近距离
      intersect = min(intersect, cylIntersect(p, refl, a, b, r));
    }
    // 打包返回：x=AO，y=阴影，z=反射距离
    return vec3(ao, shadow, intersect);
  }

  /** 用矩阵的「方向变换」语义变换方向量（w=0，忽略平移），并归一化 */
  vec3 inverseTransformDirection(in vec3 dir, in mat4 matrix) {
    // vec4(dir, 0) 与矩阵相乘 → 只受旋转/缩放影响；函数名沿用了 Three.js 的习惯命名
    return normalize((vec4(dir, 0.0) * matrix).xyz);
  }

  /** Uncharted 2 风格的 filmic 色调映射曲线（Hable 简化版：6.2 / 0.5 / 1.7 / 0.06） */
  vec3 filmicToneMapping(vec3 color) {
    // 先减 0.004 的趾部偏移，把纯黑压到 0，避免暗部发灰
    color = max(vec3(0.), color - vec3(0.004));
    // 有理函数曲线：把 HDR 值压缩到 [0,1)，亮部平滑趋近 1
    color = (color * (6.2 * color + .5)) / (color * (6.2 * color + 1.7) + 0.06);
    // 返回映射后的颜色
    return color;
  }

  void main() {
    // 蓝噪声：+ (3,9) 的像素偏移用来打破与其他蓝噪声采样的相关性
    vec3 blueNoise = getBlueNoise(gl_FragCoord.xy + vec2(3., 9.));

    // 双面渲染时用 gl_FrontFacing 修正法线朝向
    float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
    // 修正后的相机空间法线
    vec3 viewNormal = faceDirection * normalize(v_viewNormal);
    // 修正后的相机空间平滑法线（用于 matcap）
    vec3 smoothViewNormal = faceDirection * normalize(v_smoothViewNormal);

    // 世界空间视线方向（表面 → 相机）
    vec3 V  = normalize(cameraPosition - v_worldPosition);
    // 相机空间法线 → 世界空间法线
    vec3 N  = inverseTransformDirection(viewNormal, viewMatrix);
    // 相机空间平滑法线 → 世界空间平滑法线
    vec3 SN = inverseTransformDirection(smoothViewNormal, viewMatrix);

    // 粗糙度 = 基础粗糙度 + 屏幕空间法线变化量（远处自动变"糊"）
    // fwidth 是屏幕空间导数，dot(vec3(1), .) 把三个分量求和，上限 0.9
    float roughness = min(0.9, u_roughness + dot(vec3(1.0), fwidth(viewNormal)));

    // 视线关于法线的反射方向
    vec3 reflectView = reflect(-V, N);
    // 粗糙时用蓝噪声扰动反射方向（0.5 幅度），光滑时几乎不动（0.01）
    vec3 reflectViewBN = normalize(reflectView + (blueNoise - .5) * (roughness > 0.5 ? 0.5 : 0.01));

    // 表面指向光源的向量
    vec3 worldToLight = u_lightPosition - v_worldPosition;
    // 单位光方向
    vec3 L = normalize(worldToLight);

    // N·V，clamp 下限 0.001 防止后续除法出现 0
    float NdV = clamp(abs(dot(N, V)), 0.001, 1.0);
    // N·L，同样防止 0
    float NdL = clamp(dot(N, L), 0.001, 1.0);

    // GI 累加器，初值 1（基础环境项）
    vec3 gi = vec3(1.0);
    // 反射结果：rgb = 邻居颜色，a = 当前最近命中距离（初值 100 = 未命中）
    vec4 reflections = vec4(0., 0., 0., 100.);
    // AO 累加器
    float ao = 1.0;
    // 阴影累加器
    float shadow = 1.0;
    // 反照率（最后乘上本球颜色）
    vec3 albedo = vec3(1.0);

    // —— 遍历 21 个邻居 ——
    for (int i = 0; i < NEIGHBOUR_COUNT; i++) {
      // 邻居颜色
      vec3 nearColor = u_nearColorList[i];
      // 邻居的半透明度与亮度
      vec2 nearTransparencyLuma = u_nearTransparencyLumaList[i].xy;

      // 求该邻居对本点的 AO / 阴影 / 反射距离
      vec3 aoShadowIntersect = getCrossAoShadowIntersect(
        // 着色点世界位置
        v_worldPosition, N, worldToLight, reflectViewBN,
        // 邻居位置/半径、旋转、当前已知的最近反射距离（用于提前剔除）
        u_nearPositionRadiusList[i], u_nearRotationList[i], reflections.w
      );

      // 取出邻居 AO
      float _ao = aoShadowIntersect.r;
      // 半透明邻居的遮蔽感更弱：按透明度最多补偿 0.5
      _ao = saturate(_ao + 0.5 * nearTransparencyLuma.x);
      // 累乘到总 AO
      ao *= _ao;
      // 累乘阴影
      shadow *= aoShadowIntersect.g;

      // 颜色渗透（GI）
      // 邻居越亮（luma 越低表示越亮？此处按原站公式直接使用），渗透越强；
      // 3.0 是强调系数，(1 - _ao²)/0.7 让越贴近遮蔽处的渗透越弱，min 限制到 1
      gi += (1.0 - 0.9 * nearTransparencyLuma.y) * nearColor * 3.0 * min(1., (1.0 - _ao * _ao) / 0.7);

      // 该邻居的反射命中距离
      float neighNearFarDist = aoShadowIntersect.b;
      // 只有比已知更近、且确实命中（>0.0001）才更新反射结果
      if (neighNearFarDist < reflections.w && neighNearFarDist > 0.0001) {
        // 半透明邻居的反射颜色稍暗，记录颜色与新的最近距离
        reflections = vec4(vec3((1.0 - 0.5 * nearTransparencyLuma.x) * nearColor), neighNearFarDist);
      }
    }

    // 反射强度按距离衰减：粗糙度越大衰减越快；+4 是常数底，避免近距离过曝
    reflections.rgb *= 1. / ((0.2 + roughness * 0.8) * reflections.w * 10. + 4.);
    // 反射再乘上邻居 AO 与顶点烘焙 AO
    reflections = reflections * ao * v_ao;
    // GI 取平均（除以邻居数）
    gi /= float(NEIGHBOUR_COUNT);

    // 反照率乘上本球颜色
    albedo *= u_color;

    // —— matcap ——
    // 相机空间视线方向
    vec3 viewDir = normalize(v_viewPosition);
    // 构造 matcap 的切线基：把视线投影到 xy 平面并旋转 90°
    vec3 x = normalize(vec3(viewDir.z, 0.0, -viewDir.x));
    // 副切线 = 视线 × 切线
    vec3 y = cross(viewDir, x);
    // 用切线基把法线映射到 [-1,1] 再转成 [0,1] 的 matcap UV
    vec2 uvPerturbed = vec2(dot(x, viewNormal), dot(y, viewNormal)) * 0.5 + 0.5;

    // 采样 matcap
    vec3 matcapMap = texture2D(u_matcap, uvPerturbed).rgb;
    // r 通道 = 漫反射
    vec3 matcapDiff = vec3(matcapMap.r);
    // 粗糙（>0.5）用 g 通道，光滑用 b 通道作为高光
    vec3 matcapSpec = vec3(roughness > .5 ? matcapMap.g : matcapMap.b);

    // 有阴影/自阴影时可反射略微变暗（0.75~1.0）
    reflections.rgb *= 0.75 + 0.25 * shadow * v_selfShadow;
    // 漫反射抬底：避免完全死黑，保留 25% 基础亮度
    matcapDiff = 0.25 + 0.75 * matcapDiff;
    // 阴影抬底：环境光让阴影不至于全黑（0.6 为底）
    shadow = 0.6 + 0.4 * shadow;

    // 自阴影系数
    float selfShadow = v_selfShadow;

    // —— 最终合成（不透明分支）——
    // 最终颜色
    vec3 color;
    // 漫反射 + 高光
    color = albedo * matcapDiff + matcapSpec;
    // 叠加邻居反射
    color += reflections.rgb;
    // 乘 AO
    color *= ao;
    // 叠加 GI（颜色渗透）
    color += gi;
    // 乘逐顶点自阴影
    color *= selfShadow;
    // 乘邻居阴影
    color *= shadow;

    // 输出 RGB
    gl_FragColor.rgb = color;
    // 原站这行是为了跟半透明玻璃球做混合；我们全部不透明，alpha 必须写 1，
    // 否则在 alpha 画布上整片像素会被浏览器合成掉（表现为只剩一点高光碎块）
    gl_FragColor.a = 1.0;
    // pow(2.2) 先把 sRGB 反照率解码到线性空间，再做 filmic 色调映射
    gl_FragColor.rgb = filmicToneMapping(pow(gl_FragColor.rgb, vec3(2.2)));
  }
`;
