/**
 * FluidGUI.js — 流体效果的实时参数面板（lil-gui）
 *
 * 直接绑定 ScreenPaint / ScreenPaintDistortion 上的公开字段：
 * 这些字段每帧都会被读取，所以拖动滑块会立刻生效，不需要重建管线。
 *
 * 分组说明：
 *   模拟     —— 速度场的推力、衰减、湍流噪声（决定"流动感"）
 *   停手     —— 松手后速度如何收掉、墨迹如何向外摊开
 *   折射     —— 屏幕折射 / 拖影 / 色散（只影响观感，不影响物理）
 *
 * @returns {GUI} 销毁时调用 gui.destroy()
 */

import GUI from 'lil-gui';

/**
 * 创建流体参数面板
 *
 * @param {object} screenPaint — ScreenPaint 实例（速度场 / 墨量模拟）
 * @param {object} distortion — ScreenPaintDistortion 实例（屏幕折射后处理）
 * @returns {GUI} lil-gui 实例，销毁时调用 gui.destroy()
 *
 * 实现要点：add() 的是对象上的字段名，lil-gui 通过 getter/setter 双向绑定，
 * 所以这里的参数顺序统一为 add(对象, '字段名', 最小值, 最大值, 步长)。
 */
export function createFluidGUI(screenPaint, distortion) {
  const gui = new GUI({ title: '流体参数' });
  // 面板浮在 canvas 之上，z-index 必须高于效果层的默认层级
  gui.domElement.style.zIndex = '20';

  // —— 模拟（速度场本体）——
  // pushStrength：鼠标按下时注入速度场的推力大小
  // radiusDistanceRange：笔刷作用半径（像素）
  // accelerationDissipation：加速度累积的衰减，越小越"跟手"
  // velocityDissipation：速度场每帧的保留比例（越接近 1 流得越远）
  // weight1/weight2Dissipation：两层墨量的衰减速度，决定拖尾长度
  const sim = gui.addFolder('模拟');
  sim.add(screenPaint, 'pushStrength', 0, 80, 1).name('推力 pushStrength');
  sim.add(screenPaint, 'radiusDistanceRange', 10, 500, 1).name('笔刷半径范围');
  sim.add(screenPaint, 'accelerationDissipation', 0, 1, 0.01).name('速度累积衰减');
  sim.add(screenPaint, 'velocityDissipation', 0.9, 1, 0.001).name('速度衰减');
  sim.add(screenPaint, 'weight1Dissipation', 0.8, 1, 0.001).name('墨量1 衰减');
  sim.add(screenPaint, 'weight2Dissipation', 0.5, 1, 0.001).name('墨量2 衰减');
  // 使用 curl noise 做湍流扰动：curlScale 控制噪声频率，curlStrength 控制扰动幅度
  sim.add(screenPaint, 'useNoise').name('启用湍流噪声');
  sim.add(screenPaint, 'curlScale', 0.005, 0.1, 0.001).name('噪声尺度');
  sim.add(screenPaint, 'curlStrength', 0, 12, 0.1).name('噪声强度');

  // —— 停手行为 ——
  // 松手后不是立刻停住，而是经过 idleDelay 秒的延迟，
  // 再用 idleRamp 秒把推力平滑收掉（避免速度突变导致的画面跳变）
  const idle = gui.addFolder('停手');
  idle.add(screenPaint, 'idleDelay', 0, 0.5, 0.01).name('停手延迟(秒)');
  idle.add(screenPaint, 'idleRamp', 0.02, 0.6, 0.01).name('收力时长(秒)');
  // idleDampingStrength：额外抑制残留速度；idleSpread：让墨迹向外缓慢摊开
  idle.add(screenPaint, 'idleDampingStrength', 0, 0.6, 0.01).name('残留速度抑制');
  idle.add(screenPaint, 'idleSpread', 0, 20, 0.5).name('向外扩散');
  // 默认折叠，面板初始状态尽量简洁
  idle.close();

  // —— 折射后处理 ——
  // 这一组只影响最终观感，不参与速度场/墨量模拟
  // amount：拖影采样长度；rgbShift：RGB 三通道的分离量（色散）
  // multiplier：位移倍率；colorMultiplier / shade：彩边强度与亮度
  const fx = gui.addFolder('折射');
  fx.add(distortion, 'amount', 0, 10, 0.1).name('拖影长度 amount');
  fx.add(distortion, 'rgbShift', 0, 2, 0.01).name('色散 rgbShift');
  fx.add(distortion, 'multiplier', 0, 25, 0.5).name('位移倍率');
  fx.add(distortion, 'colorMultiplier', 0, 40, 0.5).name('彩边强度');
  fx.add(distortion, 'shade', 0, 3, 0.05).name('彩边亮度');
  fx.close();

  // 用一个临时对象包一个 reset 方法，让 lil-gui 生成一个"恢复默认"按钮；
  // gui.reset() 会把上面所有控制器改回初始值
  gui.add({ reset: () => gui.reset() }, 'reset').name('恢复默认');

  return gui;
}
