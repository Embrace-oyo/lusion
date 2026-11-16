# 气球物理特效 — 教程配套源码

配合掘金文章《22 个气球，怎样互相映照：拆解 Lusion 主页的气球特效》使用。
文章正文见 [掘金-气球物理特效教程.md](./掘金-气球物理特效教程.md)，配图在 `images/` 下。

这是一个**独立可运行**的最小工程，只保留气球效果本身，不依赖 Vue 或原项目。Three.js + 原生 JS + Vite。

## 怎么跑

```bash
npm install
npm run dev
```

打开终端提示的地址，移动鼠标推开气球，点击画面切换配色。

> 需要 WebGL2，建议桌面版 Chrome / Edge / Safari。

## 目录结构

```
balloons-tutorial/
├── index.html                    # 页面骨架 + 挂载点
├── main.js                       # 入口：new BalloonsExperience().mount()
├── package.json
├── public/assets/
│   ├── models/home/cross.buf     # 气球几何体（原站二进制格式）
│   └── textures/home/matcap.exr  # r=漫反射 g=粗糙高光 b=光滑高光
└── src/
    ├── BalloonsExperience.js     # 渲染器 / 帧循环 / dolly-zoom / 后处理
    ├── HomeBalloons.js           # 22 个气球：材质、邻居排序、换色
    ├── HomeBalloonsPhysics.js    # 向心重力、两两碰撞、鼠标推挤
    ├── HomeBalloonsBackground.js # 背景渐变
    ├── Stage3D.js                # 相机 / 渲染器 / 尺寸基类
    ├── BufLoader.js              # .buf 解析（含 daoN/daoP/SN/ao 属性）
    ├── balloon.js                # 气球顶点/片元着色器
    ├── background.js             # 背景着色器
    ├── Input.js                  # 鼠标 / 触摸
    ├── BlueNoise.js              # 蓝噪声贴图
    ├── lusionData.js             # 22 个球的配置、5 套主题色、物理常量
    ├── math.js
    └── FinalPass.js / SmaaPass.js / FsrPass.js
```

## 常用参数

`src/effects/lusionData.js`：

```js
GRAVITY_FACTOR: 40,       // 指向原点的重力
BODY_RADIUS_SCALE: 1.05,  // 物理半径 = 1.05 * 几何半径
MOUSE_RADIUS: 0.025,      // 鼠标射线管的半径
MOUSE_INFLUENCE: 0.1,     // 推开位移
MOUSE_PUSH_FORCE: 0.12,   // 推力
POSITION_SPREAD: 12,      // 初始分布范围
POSITION_Z_RANGE: 6,
```

`src/effects/BalloonsExperience.js`：

```js
BASE_FOV = 25;            // 长焦
相机 z: 25 → 17.5         // 开场推轨（0.3s ~ 2s）
FOV: 125 → 25             // 同时变焦（0.3s ~ 3s）
```

## 想改点什么

- **换主题色**：改 `lusionData.js` 里的 `BALLOON_COLORS`
- **换几何体**：替换 `public/assets/models/home/cross.buf`，保持属性布局不变；或删掉文件走程序化退化路径
- **关后处理**：把 `BalloonsExperience` 里 `finalPass / smaaPass / fsrPass` 的 `enabled` 设为 `false`

## 说明

原效果来自 [Lusion](https://lusion.co)，仅用于学习与图形学交流，模型、贴图与视觉设计版权归原作者所有。
