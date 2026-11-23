/**
 * SmaaPass.js — 原站 `Smaa` 后处理（renderOrder = 500）的等价实现
 *
 * 原站自己实现了 SMAA 三段式：
 *   1) edges：Sobel/邻域亮度差求边缘
 *   2) weights：用面积图（area）和搜索图（search）计算混合权重
 *   3) blend：邻域混合，消除几何边缘的阶梯
 *
 * three.js 的 examples 里 `SMAAPass` 使用的就是同一套 SMAA 算法与 LUT，
 * 这里直接复用它（LUT 以 data-URL 内嵌，不需要额外资源文件），
 * 只把默认状态设为启用，以便和原站保持一致。
 *
 * 注意：SMAA 需要显示空间（sRGB）颜色作为输入，所以它必须排在
 * 负责最终调色 / 输出的 pass 之后 —— 正好对应原站 Bloom(10) → Final(30) → Smaa(500)。
 */

import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

export class SmaaPass extends SMAAPass {

  constructor() {
    // 父类会创建 edges / weights 两张 RT 与面积/搜索 LUT 纹理
    super();

    // 命名，便于在调试器里辨认
    this.name = 'SmaaPass';

    // 原站默认开启 SMAA
    this.enabled = true;
  }
}
