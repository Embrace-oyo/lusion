/**
 * background.js — 主页背景（移植自原站 vert$k / frag$o）
 *
 * 原站背景极其克制：整屏铺满一个近黑色（u_color1 = #141515），
 * 只在离屏幕中心较远时混入 7.5% 的 u_color0，再加一点蓝噪声抖动。
 * 真正的"氛围"来自气球本身，而不是背景渐变。
 */

/**
 * 背景顶点着色器。
 *
 * 输入几何体是一块已经位于裁剪空间（clip space）的平面，顶点 x/y 直接就是 NDC 坐标，
 * 因此这里不需要 modelView / projection 矩阵，直接把 position 当 gl_Position 用。
 * 作用：把整屏铺满，同时为内圈顶点做一次「屏幕裁剪框」的形变（用于全屏转场）。
 *
 * 调用方：主页背景材质（Background 类），以全屏三角/平面网格绘制。
 */
export const backgroundVertex = /* glsl */`
  // 裁剪缩放：内圈顶点按此比例缩放（转场时收缩画面）
  uniform vec2 u_clipScale;
  // 裁剪偏移：缩放后整体平移，避免缩小时露出画布边缘
  uniform vec2 u_clipOffset;

  // 传给片元的 0~1 UV，用于计算到屏幕中心的距离（暗角/渐变）
  varying vec2 v_uv;

  void main() {
    // 拷贝一份顶点位置，后续可能被裁剪参数改写
    vec3 pos = position;
    // 取绝对值，用来判断顶点是否落在屏幕中心区域（|x|、|y| 都 < 0.9）
    vec3 absPos = abs(position);
    // 只有内圈顶点跟随 clip 参数（外圈保持超出屏幕，保证铺满）
    if (max(absPos.x, absPos.y) < 0.9) {
      // 内圈按 u_clipScale 缩放并加上 u_clipOffset 平移
      pos.xy = pos.xy * u_clipScale + u_clipOffset;
      // 再放大 2 倍，让内圈顶点足够覆盖整屏（平面本身大概是 ±1 的四边形）
      pos *= 2.;
    }
    // 已经是裁剪空间坐标，直接输出（w = 1，无透视）
    gl_Position = vec4(pos, 1.0);
    // NDC 的 [-1,1] 映射到 UV 的 [0,1]
    v_uv = vec2(pos.x, pos.y) * 0.5 + 0.5;
  }
`;

/**
 * 背景片元着色器。
 *
 * 输出一张几乎纯色的近黑背景：
 *   - 用屏幕中心距离做 smoothstep，最边缘混入少量 u_color0，形成极弱的径向渐变；
 *   - 叠加 0.004 强度的蓝噪声抖动，消除大面积纯色在 8bit framebuffer 上的色带；
 *   - alpha 固定写 0，因为背景只需提供 RGB（与主渲染的透明度通道解耦）。
 *
 * 调用方：与 backgroundVertex 配套的全屏背景材质。
 */
export const backgroundFragment = /* glsl */`
  // 边缘色（原站 #141515 之外混入的第二种颜色）
  uniform vec3  u_color0;
  // 主体色（近黑，屏幕绝大部分区域的颜色）
  uniform vec3  u_color1;
  // 屏幕宽高比，用于把圆形距离场拉伸成椭圆，避免渐变在宽屏上变扁
  uniform float u_aspect;
  // 距离渐变的 smoothstep 区间 (edge0, edge1)
  uniform vec2  u_smooth;
  // 当前时间（本 shader 未使用，保留以匹配原站 uniform 布局）
  uniform float u_time;

  // 蓝噪声贴图：低差异噪声，用极低强度打散色带
  uniform sampler2D u_blueNoiseTexture;
  // 蓝噪声贴图的 1/分辨率，把像素坐标换算成 UV
  uniform vec2      u_blueNoiseTexelSize;
  // 蓝噪声采样偏移，逐帧变化可让抖动图案动起来
  uniform vec2      u_blueNoiseCoordOffset;

  // 来自顶点着色器的 0~1 屏幕 UV
  varying vec2 v_uv;

  /** 按像素坐标采样蓝噪声，返回 rgb 三通道噪声值 */
  vec3 getBlueNoise(vec2 coord) {
    // coord 是像素坐标，乘 texelSize 变 UV，再加偏移做平铺/抖动
    return texture2D(u_blueNoiseTexture, coord * u_blueNoiseTexelSize + u_blueNoiseCoordOffset).rgb;
  }

  void main() {
    // 以当前像素坐标采样蓝噪声
    vec3 noise = getBlueNoise(gl_FragCoord.xy);
    // 把 UV 转成以屏幕中心为原点的坐标，范围约 [-0.5, 0.5]
    vec2 q = vec2(v_uv - 0.5);
    // x 方向乘以宽高比 → 距离场变成「按屏幕比例拉长」，渐变在视觉上是圆形
    q.x *= u_aspect;
    // 到屏幕中心的距离
    float dst = length(q);
    // 把距离重映射到 0~1：区间内为 0，区间外为 1
    dst = smoothstep(u_smooth.x, u_smooth.y, dst);
    // 主体色几乎恒定（0.925 起步），仅在边缘最多混入 7.5% 的边缘色
    vec3 color = mix(u_color0, u_color1, 0.925 + 0.075 * dst);
    // 加极弱的蓝噪声（0.004），纯粹用于抖动/去色带
    color += noise * 0.004;
    // 输出 RGB
    gl_FragColor.rgb = color;
    // alpha 固定 0：背景不参与 alpha 合成，只提供颜色
    gl_FragColor.a = 0.0;
  }
`;
