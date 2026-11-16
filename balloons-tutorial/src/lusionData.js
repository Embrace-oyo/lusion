/**
 * lusionData.js — 从 lusion.co 的 hoisted bundle 中逆向提取的**精确常量**
 *
 * 这些数值直接来自原站（SPHERES_DATA），用于 1:1 复刻主页气球特效。
 * 仅用于学习研究，资源与参数版权归 Lusion 所有。
 */

/** 5 套主题色，点击气球时循环切换 */
// 索引顺序即切换顺序；'fancy' 气球会取当前索引对应的颜色
export const BALLOON_COLORS = [
  '#061dfb', // 0 蓝
  '#ADFF00', // 1 荧光绿
  '#f6000e', // 2 红
  '#7e09f5', // 3 紫
  '#ffc000', // 4 橙
];

/** 四种材质的物理参数 —— 原站四个预设完全相同 */
// density：密度，参与质量计算；friction：碰撞摩擦；restitution：弹性（0.8 = 每次反弹保留 80% 速度）
// 因为四个预设一致，这里抽成一份共享常量，避免在每个球上重复书写
const PRESET = { density: 1, friction: 2, restitution: 0.8 };

/**
 * 22 个气球的精确配置（顺序与原站一致）
 *   fancy × 6 / 白色 × 8 / 近黑 #111 × 8
 *   isRough 决定 matcap 用哪个通道做高光（粗糙 g / 光滑 b）
 *   radius 全为 1 → 物理半径 = 1.05
 */
const RAW = [
  { color: 'fancy',   isRough: true  },
  { color: 'fancy',   isRough: true  },
  { color: 'fancy',   isRough: false },
  { color: '#ffffff', isRough: true  },
  { color: '#ffffff', isRough: true  },
  { color: '#ffffff', isRough: true  },
  { color: '#ffffff', isRough: false },
  { color: '#111',    isRough: true  },
  { color: '#111',    isRough: true  },
  { color: '#111',    isRough: true  },
  { color: '#111',    isRough: false },
  { color: 'fancy',   isRough: true  },
  { color: 'fancy',   isRough: true  },
  { color: 'fancy',   isRough: false },
  { color: '#ffffff', isRough: true  },
  { color: '#ffffff', isRough: true  },
  { color: '#ffffff', isRough: true  },
  { color: '#ffffff', isRough: false },
  { color: '#111',    isRough: true  },
  { color: '#111',    isRough: true  },
  { color: '#111',    isRough: true  },
  { color: '#111',    isRough: false },
];

/**
 * 生成气球配置数组
 *
 * 在原始配色表基础上套用当前主题色，并补齐物理/材质默认值。
 * 每次点击换色只需重新调用一次，得到一份全新的配置数组。
 *
 * @param {string} fancyHex 当前主题色
 * @returns {Array<object>} 22 个气球的完整参数
 */
export function makeSphereData(fancyHex = BALLOON_COLORS[0]) {
  return RAW.map((r) => ({
    // 'fancy' 占位色替换成当前主题色，其余写死的 hex 保持不变
    color: r.color === 'fancy' ? fancyHex : r.color,
    // 几何半径统一为 1，物理半径由 PHYSICS.BODY_RADIUS_SCALE 再放大
    radius: 1,
    isRough: r.isRough,
    // isBlackWhite / isColored / isSemitransparent 供材质分支使用，原站主页只用到了 isColored
    isBlackWhite: false,
    isColored: r.color === 'fancy',
    isSemitransparent: false,
    // 展开共享的物理参数（density / friction / restitution）
    ...PRESET,
  }));
}

/** 物理常量（原站 HomeBalloonsPhysics / HomeBalloonsBody） */
// 这组数值决定了"气球被鼠标推一下然后慢慢飘回中心"的整体手感，改动前先对照原站
export const PHYSICS = {
  GRAVITY_FACTOR: 40,       // 指向原点的重力
  BODY_RADIUS_SCALE: 1.05,  // 物理半径 = 1.05 * radius
  MOUSE_RADIUS: 0.025,
  MOUSE_INFLUENCE: 0.1,
  MOUSE_PUSH_FORCE: 0.12,
  POSITION_SPREAD: 12,      // 初始位置 (rand-0.5)*12
  POSITION_Z_RANGE: 6,      // 初始 z (rand-0.5)*6
};

/** 相机参数（原站 Stage3D 配置） */
// FOV 只有 25°（长焦观感），配合相机位于原点、气球围绕原点分布来获得较小的透视变形
export const CAMERA = {
  FOV: 25,
  POSITION: [0, 0, 0],
};
