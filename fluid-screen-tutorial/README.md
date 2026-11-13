# 屏幕流体特效 — 教程配套源码

配合掘金文章《我以为是流体解算，结果只是一张贴图：复刻 Lusion 的屏幕流体特效》使用。
文章正文见 [掘金-屏幕流体特效教程.md](./掘金-屏幕流体特效教程.md)，配图在 `images/` 下。

这是一个**独立可运行**的最小工程，只保留了流体效果本身，不依赖 Vue 或原项目。用的是 Three.js + 原生 JS + Vite。

## 怎么跑

```bash
npm install
npm run dev
```

打开终端里提示的地址（默认 `http://localhost:5173`），移动鼠标就能看到效果。右上角是 lil-gui 参数面板，可以直接拖。

> 需要 WebGL2，建议用桌面版 Chrome / Edge / Safari。

## 目录结构

```
fluid-screen-tutorial/
├── index.html                 # 页面骨架 + 挂载点
├── main.js                    # 入口：new FluidExperience().mount()
├── package.json
└── src/
    ├── FluidExperience.js     # 运行时：渲染器 / 渲染循环 / pass 编排
    ├── ScreenPaint.js         # 四通道速度场：平流、衰减、笔刷注入
    ├── ScreenPaintDistortion.js # 折射 pass：9 次偏移采样 + 色散
    ├── fluidBase.js           # 被扭曲的底图（渐变 + 双色软斑 + 圆环）
    ├── Input.js               # 鼠标 / 触摸输入
    ├── FluidGUI.js            # lil-gui 参数面板
    ├── math.js                # fit / clamp 等小工具
    ├── FinalPass.js           # 可选后处理：暗角 / 颗粒 / 调色
    ├── SmaaPass.js            # 可选后处理：SMAA
    └── FsrPass.js             # 可选后处理：FSR1 EASU + RCAS
```

## 和文章章节的对应

| 文章里的部分 | 建议先看的文件 |
| --- | --- |
| 把数据结构定下来 | `src/ScreenPaint.js` 的 `_initTargets()` / `resize()` |
| 推：半拉格朗日平流 | `src/ScreenPaint.js` 的 `PAINT_FRAG` |
| 扣：三个衰减系数 | `PAINT_FRAG` 末尾的 `u_dissipations` 部分 |
| 画：有半径的线段 | `PAINT_FRAG` 的 `sdSegment` + `update()` 里的半径映射 |
| 降采样再模糊 | `_blurLow()` + `BLUR_FRAG` |
| 让画面“荡”起来 | `src/ScreenPaintDistortion.js` 的 `FRAG` |
| 松手之后 | `src/ScreenPaint.js` 的 `idleDelay / idleRamp / idleDamping` |
| 被扭曲的底图 | `src/fluidBase.js` |
| 顺手接进后处理 | `src/FluidExperience.js` 的 `DistortionPass` 与 composer 部分 |

## 常用参数

都在 `src/ScreenPaint.js` 的构造函数里：

```js
this.pushStrength = 25;          // 拖尾长度，越大墨迹被带得越远
this.maxRadius = Math.max(40, width / 20); // 最大笔刷半径
this.radiusDistanceRange = 100;  // 鼠标速度 → 半径的映射区间
this.velocityDissipation = 0.975;
this.weight1Dissipation = 0.95;
this.weight2Dissipation = 0.8;
this.curlScale = 0.02;           // 噪声湍流缩放
this.curlStrength = 3;           // 涡流强度
this.idleDelay = 0.06;           // 停手多久开始收力
this.idleRamp = 0.14;            // 收力持续时间
this.idleDampingStrength = 0.25; // 残留速度额外衰减
this.idleSpread = 6;             // 停手后向外扩散强度
```

折射参数在 `src/FluidExperience.js` 的 `distortionOptions` 里：

```js
amount: 3,            // 单步位移倍率
rgbShift: 0.5,        // 色散强度
multiplier: 5,        // 整体折射幅度
colorMultiplier: 10,  // 彩色条纹强度
shade: 1.25,          // 彩色条纹亮度
```

## 想改点什么

**换底图**：改 `src/fluidBase.js` 的片元着色器。只要保留「大色块 + 细线 + 颗粒」这个组合，折射就会好看。也可以把 `u_texture` 换成图片、视频或 DOM 纹理，`ScreenPaintDistortion` 只关心输入是一张纹理。

**关掉后处理**：在 `src/FluidExperience.js` 里把 `finalPass / smaaPass / fsrPass` 的 `enabled` 改成 `false`，或者直接从 composer 里删掉对应 `addPass`。

**接到自己的项目**：只需要 `ScreenPaint.js`、`ScreenPaintDistortion.js`、`Input.js`、`math.js` 四个文件，按 `FluidExperience` 里的顺序调用即可：

```
输入 → ScreenPaint.update() → 场景渲染到 baseRT → Distortion.render(baseRT.texture, target)
```

## 说明

原效果来自 [Lusion](https://lusion.co)，本仓库仅用于学习与图形学交流。模型、贴图与视觉设计的版权归原作者所有，请勿用于商业用途。
