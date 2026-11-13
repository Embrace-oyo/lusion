/**
 * math.js — 通用数学工具函数集合
 *
 * 提供: clamp / lerp / smoothstep / fit / mod / ease.backOut / Mulberry32 伪随机
 * 所有函数均为无状态纯函数，便于在 Three.js Shader 和 JS 逻辑中复用
 *
 * 这些实现与 GLSL 内置函数（clamp / mix / smoothstep / mod）语义保持一致，
 * 方便在 JS 侧算出的动画曲线直接对应到 shader 里的同名计算。
 */

/** 将值限制在 [min, max] 范围内 */
// 先 min 后 max：min 用 Math.min 取上界，外层 Math.max 取下界
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/** 线性插值：t ∈ [0,1]，从 a 到 b */
// 等价于 GLSL 的 mix(a, b, t)；t 不 clamp，可用于外推
export const lerp = (a, b, t) => a + (b - a) * t;

/** Hermite 平滑插值：smoothstep(edge0, edge1, x) */
// 先把 x 归一化到 [0,1]，再用 t²(3-2t) 做 S 型平滑（两端一阶导为 0）
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** 映射 fit(value, inMin, inMax, outMin, outMax) — 带 clamp 的范围映射 */
// 三段式：先把输入归一化并 clamp 到 [0,1]，再用 lerp 映射到输出区间
export const fit = (v, inMin, inMax, outMin, outMax) =>
  lerp(outMin, outMax, clamp((v - inMin) / (inMax - inMin), 0, 1));

/** 模运算：与 GLSL mod 行为一致，始终返回非负值 */
// JS 的 % 对负数会产生负结果（如 -1 % 3 = -1），再加一个周期再取模即可修正
export const mod = (a, b) => ((a % b) + b) % b;

/**
 * ease.backOut — 带过冲的缓出动画曲线
 * t ∈ [0, 1]，返回值在 t=1 时为 1，中间可能略大于 1（过冲）
 *
 * 数学形式：1 + c3·(t-1)³ + c1·(t-1)²
 *  - c1 控制过冲幅度（经典值是 1.70158，约产生 10% 回弹）
 *  - c3 = c1 + 1 是为了让 t=1 时恰好等于 1（两项都含 (t-1)，t=1 时归零）
 */
export const easeBackOut = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  // (t-1) 为负值：三次项提供整体上升趋势，二次项在结束前形成正向过冲
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/**
 * Mulberry32 伪随机数生成器工厂
 * 给定一个 seed，返回一个每次调用产生 [0,1) 均匀随机数的函数
 * 用于程序化蓝噪声、气球初始位置等可复现随机场景
 *
 * 特点：状态只有 32 位，速度快、分布质量足够做视觉用途，
 * 同一个 seed 在任何设备上都会得到完全相同的序列（便于截图/测试复现）。
 *
 * @param {number} seed — 整数种子
 * @returns {() => number}
 */
export const getSeedRandomFn = (seed) => {
  let a = seed >>> 0; // 强制无符号 32 位
  return () => {
    // 推进内部状态：加上固定增量 0x6d2b79f5（黄金比例常数的一个位模式）
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    // 下面几行是 Mulberry32 的混淆步骤：
    // 通过两次 xorshift（>>> 15 / >>> 7）配合 Math.imul 的 32 位乘法充分打散比特
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    // 最后再右移 14 位并转成无符号，除以 2³² 得到 [0,1) 的浮点数
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
