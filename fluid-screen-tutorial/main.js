/**
 * main.js — 教程源码入口（原生 JS，不依赖任何框架）
 *
 * 这里只做三件事：
 *   1. 找到挂载容器
 *   2. new FluidExperience() 并 mount
 *   3. 页面卸载 / HMR 时销毁，避免 WebGL 上下文泄漏
 */

// 流体效果运行时（内部负责渲染器、RT、模拟、后处理、帧循环）
import { FluidExperience } from './src/FluidExperience.js';

// 挂载容器：index.html 里铺满全屏的 #app
const host = document.getElementById('app');

// 创建实例（默认会显示右上角的 lil-gui 参数面板）
const experience = new FluidExperience();

// 挂载：创建 canvas、初始化 RT、启动帧循环
experience.mount(host);

// Vite HMR：热更新时先销毁旧实例，否则会叠加多个 WebGL 上下文
if (import.meta.hot) {
  import.meta.hot.dispose(() => experience.dispose());
}
