/**
 * fluidBase.js — 流体效果页的"被扭曲内容"
 *
 * 这个着色器只负责画一张有层次、有对比的画面（米白底 + 蓝色/珊瑚色软斑 + 细圆环）。
 * 它本身不参与流体计算，唯一作用是被 ScreenPaintDistortion 采样，
 * 让鼠标画出的速度场在画面上产生可见的折射、拖影与色散。
 *
 * 画面元素的选择理由：
 *   - 大块高饱和色斑：折射时产生明显的形变
 *   - 细同心环：位移/色散在细线上会被放大，最容易看出"流体"感
 *   - 颗粒噪点：掩盖 8bit 色带
 */

/**
 * 顶点着色器：把全屏四边形直接铺到裁剪空间。
 *
 * 这里显式声明 position / uv 属性（不走 Three.js 的 ShaderMaterial 自动注入），
 * 说明该材质可能以 RawShaderMaterial 或自定义 BufferGeometry 方式使用。
 * 作用只有两件：把 uv 传给片元、把顶点放到 [-1,1] 的 NDC 覆盖整屏。
 *
 * 调用方：流体效果页的底色材质（FluidBase），其输出会被 ScreenPaintDistortion 采样。
 */
export const fluidBaseVertexShader = /* glsl */`
  // 顶点位置，x/y 已经是 [-1,1] 的裁剪空间坐标
  attribute vec3 position;
  // 顶点 UV，0~1
  attribute vec2 uv;
  // 传给片元的 UV
  varying vec2 v_uv;

  void main() {
    // 原样传递 UV，片元里用它做竖向渐变
    v_uv = uv;
    // 只取 x/y 放进裁剪空间，z 固定 0，w = 1（无透视，铺满整屏）
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * 片元着色器：绘制一张「米白底 + 蓝色/珊瑚色软斑 + 细同心环 + 颗粒」的测试图。
 *
 * 这张图本身不是最终画面，它的价值在于被流体扭曲 pass 采样：
 * 大色块让折射形变可见，细圆环让位移/色散被放大，颗粒掩盖 8bit 色带。
 *
 * 调用方：流体效果页的底色材质（FluidBase）。
 */
export const fluidBaseFragmentShader = /* glsl */`
  // 使用高精度浮点，避免大色块渐变出现明显色带
  precision highp float;

  // 画布分辨率（像素），用于宽高比校正
  uniform vec2 u_resolution;
  // 时间（秒），驱动色斑漂移与圆环滚动
  uniform float u_time;
  // 来自顶点着色器的 0~1 UV
  varying vec2 v_uv;

  /** 12 通道哈希：把 2D 坐标映射成 [0,1) 的伪随机数，用于颗粒噪点 */
  float hash12(vec2 p) {
    // 用三个错位分量构造 vec3，乘上无理数常数后取小数部分，打散输入规律
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    // 加上自身点积（含错位），进一步混合各分量
    p3 += dot(p3, p3.yzx + 33.33);
    // 再乘一次并取小数，得到分布较均匀的标量噪声
    return fract((p3.x + p3.y) * p3.z);
  }

  void main() {
    // 拷贝 UV（保持可读性，后续主要用校正后的坐标 p）
    vec2 uv = v_uv;

    // 宽高比校正：用短边归一化，圆斑在任何比例下都保持圆形
    vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);

    // 底色：底部暖白 → 顶部冷灰
    vec3 color = mix(
      // 屏幕底部的暖白（米色）
      vec3(0.95, 0.94, 0.90),
      // 屏幕顶部的冷灰
      vec3(0.75, 0.77, 0.81),
      // uv.y = 0 在底部（暖白），uv.y = 1 在顶部（冷灰），线性过渡
      smoothstep(0.0, 1.0, uv.y)
    );

    // 电光蓝软斑（缓慢漂移）
    // 圆心用两个不同频率的正余弦做李萨如式漂移，避免机械的直线运动
    vec2 c1 = vec2(-0.40 + 0.10 * sin(u_time * 0.31), 0.05 + 0.08 * cos(u_time * 0.23));
    // smoothstep(0.62, 0.02, dist)：距离越近权重越大（区间反向），乘 0.92 限制最大混合量
    color = mix(color, vec3(0.05, 0.16, 0.96), smoothstep(0.62, 0.02, length(p - c1)) * 0.92);

    // 珊瑚色软斑
    // 同样用低频正余弦让圆心缓慢游走
    vec2 c2 = vec2(0.44 + 0.08 * cos(u_time * 0.27), -0.07 + 0.10 * sin(u_time * 0.19));
    // 半径比蓝斑小（0.46），权重 0.72，让画面形成主次对比
    color = mix(color, vec3(1.0, 0.34, 0.24), smoothstep(0.46, 0.02, length(p - c2)) * 0.72);

    // 细同心圆环：流体经过时会被"掰弯"，是最直观的参照物
    // 半径 × 6.5 得到 6~7 圈，减去时间项让圆环缓慢向外滚动；fract 取每圈的 0~1 相位
    float f = fract(length(p) * 6.5 - u_time * 0.10);
    // 只保留相位接近 1 的一小段（最后 6%），形成细线
    float ring = smoothstep(0.94, 1.0, f);
    // 圆环用近黑色，以 16% 的强度叠加，保持克制
    color = mix(color, vec3(0.06, 0.07, 0.10), ring * 0.16);

    // 颗粒：掩盖大面积渐变的 8bit 色带
    // 噪声减 0.5 变成 [-0.5,0.5]，再乘 0.028 的控制幅度
    color += (hash12(gl_FragCoord.xy) - 0.5) * 0.028;

    // 暗角
    // 到画面中心的距离在 0.45~1.25 之间线性增强，最多压暗 22%
    color *= 1.0 - 0.22 * smoothstep(0.45, 1.25, length(uv - 0.5));

    // 不透明输出：这张底色图不需要 alpha
    gl_FragColor = vec4(color, 1.0);
  }
`;
