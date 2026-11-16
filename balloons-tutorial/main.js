/**
 * main.js — 教程源码入口（原生 JS，不依赖任何框架）
 *
 * 只做三件事：找容器、创建实例、挂载。
 * 页面卸载 / HMR 时销毁实例，避免 WebGL 上下文叠加。
 */

// 气球效果运行时（内部负责渲染器、场景、物理、后处理与帧循环）
import { BalloonsExperience } from './src/BalloonsExperience.js';

// 挂载容器：index.html 里铺满全屏的 #app
const host = document.getElementById('app');

// 创建实例
const experience = new BalloonsExperience();

// 挂载：创建 canvas、装配场景、启动帧循环
experience.mount(host);

// Vite HMR：热更新时先销毁旧实例
if (import.meta.hot) {
  import.meta.hot.dispose(() => experience.dispose());
}
