import * as THREE from 'three';
import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

// 与原站保持一致：关闭 three 的颜色管理。
// 开启后 hex 颜色会做 sRGB→Linear 转换，整场月面调色会明显偏暗。
THREE.ColorManagement.enabled = false;

createApp(App).mount('#app');
