/**
 * HomeBalloonsPhysics — 1:1 移植自原站 HomeBalloonsBody / HomeBalloonsPhysics
 *
 * 行为要点:
 *   - 每个气球初始位置 (rand-0.5)*12 / (rand-0.5)*12 / (rand-0.5)*6，
 *     初速度 = 位置 × -2 → 开场所有气球从远处"射向"原点
 *   - 重力恒指向原点（GRAVITY_FACTOR = 40），速度每帧乘 pow(0.2, dt) 强阻尼
 *   - 两两碰撞：沿法线做动量守恒 + 各自的 restitution/friction
 *   - 鼠标：把 NDC 投影到 z=0 平面，球被"挤"开并带上鼠标速度
 *   - 旋转：torque = position × velocity / inertia，用 premultiply 叠加四元数
 */

import * as THREE from 'three';
import { fit } from './math.js';
import { PHYSICS } from './lusionData.js';

const GRAVITY_FACTOR = PHYSICS.GRAVITY_FACTOR;
const BODY_RADIUS_SCALE = PHYSICS.BODY_RADIUS_SCALE;
const MOUSE_RADIUS = PHYSICS.MOUSE_RADIUS;
const MOUSE_INFLUENCE = PHYSICS.MOUSE_INFLUENCE;
const MOUSE_PUSH_FORCE = PHYSICS.MOUSE_PUSH_FORCE;

/** 字符串种子 → 32bit 整数（原站用的是 "balloonBody-25"） */
function hashSeed(str) {
  // FNV-1a 32 位偏移基数
  let h = 2166136261;
  // 逐字符混入哈希
  for (let i = 0; i < str.length; i++) {
    // 异或字符码
    h ^= str.charCodeAt(i);
    // 乘 FNV 质数（用 imul 保证 32 位整数乘法不丢精度）
    h = Math.imul(h, 16777619);
  }
  // 转无符号 32 位，避免负数种子
  return h >>> 0;
}

function createRandom(seedStr) {
  // 用字符串种子初始化内部状态
  let a = hashSeed(seedStr);
  // 返回 mulberry32 风格的伪随机函数：同一种子 → 同一串随机数
  return () => {
    // 保证内部状态为 32 位有符号整数
    a |= 0;
    // 固定增量推进状态
    a = (a + 0x6d2b79f5) | 0;
    // 第一次混淆
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    // 第二次混淆（平方/异或混合），提升低位随机性
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    // 归一化到 [0,1)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// —— 模块级临时变量，避免每帧 GC ——
// 鼠标在世界空间（z=0 平面）的位置
const _mouse = new THREE.Vector3();
// 上一帧鼠标位置，用于求鼠标速度
const _mousePrev = new THREE.Vector3();
// 鼠标速度换算出的推力
const _mousePushForce = new THREE.Vector3();
// 相机 → 鼠标 的向量，用于计算鼠标"射线"上的投影
const _mouseBA = new THREE.Vector3();
// 当前遍历球体的速度（复用）
const _vel = new THREE.Vector3();
// 另一颗球的速度（复用）
const _velB = new THREE.Vector3();
// 当前遍历球体的位置（复用）
const _pos = new THREE.Vector3();
// 另一颗球的位置（复用）
const _posB = new THREE.Vector3();
// 通用临时向量 0
const _v0 = new THREE.Vector3();
// 通用临时向量 1
const _v1 = new THREE.Vector3();
// 碰撞法线
const _normal = new THREE.Vector3();
// 复用四元数，构造"轴角旋转"临时结果
const _quat = new THREE.Quaternion();
// 鼠标射线方向（unproject 后归一化）
const _mousePlane = new THREE.Vector3();
// 固定的自转轴 (1,1,1) 归一化 —— 所有球都绕同一斜轴扰动，保证视觉统一
const _axis = new THREE.Vector3(1, 1, 1).normalize();

export class HomeBalloonsBody {

  constructor(radius, density, friction, restitution, seedRand) {
    // 传入的伪随机函数（所有球共享一个序列，逐个取数保证布局确定）
    const rand = seedRand;
    // 初始位置：x/y 各在 [-6,6]，z 在 [-3,3]，形成一个扁平的球簇
    this.position0 = new THREE.Vector3(
      (rand() - 0.5) * 12,
      (rand() - 0.5) * 12,
      (rand() - 0.5) * 6
    );
    // 初速度 = 位置 × -2：指向原点且越远的球越快，开场呈"向心汇聚"
    this.velocity0 = this.position0.clone().multiplyScalar(-2);

    // 运行时位置（会被物理积分更新）
    this.position = this.position0.clone();
    // 运行时速度
    this.velocity = this.velocity0.clone();
    // 运行时朝向，初始为单位四元数
    this.quaternion = new THREE.Quaternion();

    // 本帧重力加速度（每帧重算）
    this.gravityAcc = new THREE.Vector3();
    // 本帧累计的碰撞摩擦系数（每帧减半衰减）
    this.frictionTot = 0;

    // 实际碰撞半径：数据半径 × 全局缩放
    this.radius = BODY_RADIUS_SCALE * radius;
    // 密度（影响质量与碰撞动量）
    this.density = density;
    // 摩擦系数（碰撞时参与阻尼）
    this.friction = friction;
    // 恢复系数（弹性，碰撞速度的反弹比例）
    this.restitution = restitution;

    // 体积近似（球体的 4/3πr³，这里系数写法做了简化，保持与原站一致）
    this.volume = Math.PI * this.radius * 1.333333;
    // 质量 = 体积 × r² × 密度（与原站同公式，用于动量守恒）
    this.mass = this.volume * this.radius * this.radius * this.density;
    // 转动惯量：实心球 0.4mr²
    this.inertia = this.mass * this.radius * this.radius * 0.4;
  }

  reset() {
    // 位置回到初始分布
    this.position.copy(this.position0);
    // 速度回到初始向心速度
    this.velocity.copy(this.velocity0);
    // 清空摩擦累积
    this.frictionTot = 0;
    // 朝向重置为单位四元数
    this.quaternion.identity();
  }

  /** 点击换色时给一次"爆炸"脉冲：抵消当前速度 + 随机方向 80 */
  applyImpulse() {
    // 先构造一个指向原点的"重力向"力（乘 10 更明显）
    const gravityForce = this.position.clone().negate().multiplyScalar(10);
    // acc 先拷贝一份，之后用于累加随机冲量
    const acc = gravityForce.clone();
    // 随机方向 × 80，得到爆炸式冲量
    gravityForce.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(80);
    // 冲量除以质量转换为速度增量后与向心力合并
    acc.add(gravityForce).multiplyScalar(1 / this.mass);
    // 先抵消当前速度，避免爆炸方向被旧速度掩盖
    this.velocity.negate();
    // 再叠加冲量速度
    this.velocity.add(acc);
  }

  updateGravity(dt) {
    // 重力指向原点、大小与距离成正比（弹簧式向心力），再乘全局系数
    this.gravityAcc.copy(this.position).negate().multiplyScalar(GRAVITY_FACTOR);
    // 除以质量 → 加速度
    this.gravityAcc.multiplyScalar(1 / this.mass);
    // 碰撞摩擦会削弱重力（接触越多越"粘"）
    this.gravityAcc.multiplyScalar(1 / (1 + this.frictionTot));
    // 用显式欧拉积分更新速度
    this.velocity.addScaledVector(this.gravityAcc, dt);
    // 摩擦累积每帧衰减一半，避免长时间碰撞后永久变钝
    this.frictionTot *= 0.5;
  }

  integrate(dt) {
    // 速度积分位置（显式欧拉）
    this.position.addScaledVector(this.velocity, dt);
    // 强阻尼：每帧按 pow(0.2, dt) 衰减，dt=1s 时只剩 20%，让球很快收敛
    this.velocity.multiplyScalar(Math.pow(0.2, dt));
  }
}

export class HomeBalloonsPhysics {

  constructor() {
    // 所有物理体（顺序与 HomeBalloons.meshes 一一对应）
    this.bodies = [];
    // 总开关：为 false 时跳过整个模拟
    this.isActive = true;
  }

  /** 依据气球数据创建物理体（与 HomeBalloons 的球一一对应） */
  initWorld(spheresData) {
    // 固定种子：刷新页面后气球的初始分布与运动完全一致
    const rand = createRandom('balloonBody-25');
    // 按数据列表逐个创建物理体
    for (let i = 0; i < spheresData.length; i++) {
      // 当前球的外观/物理参数
      const d = spheresData[i];
      // 同一个 rand 序列被所有球共享，保证每个球拿到的随机数不重复
      this.bodies.push(new HomeBalloonsBody(
        d.radius, d.density, d.friction, d.restitution, rand
      ));
    }
  }

  reset() {
    // 逐个复位到初始位置/速度/朝向
    for (const b of this.bodies) b.reset();
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera
   * @param {{x:number,y:number}} mouseXY — NDC 坐标
   */
  update(dt, camera, mouseXY) {
    // 总开关关闭或时间步为 0 时直接返回（避免除零）
    if (!this.isActive || dt <= 0) return;

    // 指针还没进入画面时不推开气球，否则默认鼠标点(屏幕中心)会把球簇炸散
    const hasPointer = mouseXY.active !== false;

    // —— 鼠标投影到 z = 0 平面 ——
    // 把 NDC 坐标反投影成一条从相机出发的世界空间射线（z 取 0.5 是 NDC 深度中点）
    _mousePlane.set(mouseXY.x, mouseXY.y, 0.5).unproject(camera);
    // 转成方向向量（减去相机位置再归一化）
    _mousePlane.sub(camera.position).normalize();
    // 求射线与 z=0 平面的交点参数 t（相机到该平面的距离 / 射线 z 分量）
    const t = (0 - camera.position.z) / _mousePlane.z;
    // 沿射线走 t 距离，得到相对相机的位移
    _mousePlane.multiplyScalar(t);
    // 加上相机位置 → 鼠标在世界空间 z=0 平面上的实际点
    _mouse.copy(camera.position).add(_mousePlane);

    // 鼠标速度 = 本帧位移 / dt，再乘推力系数；用于推挤气球
    _mousePushForce.copy(_mouse).sub(_mousePrev).multiplyScalar(MOUSE_PUSH_FORCE / dt);
    // 相机 → 鼠标 的向量，后面用来做"球到鼠标射线"的投影
    _mouseBA.copy(_mouse).sub(camera.position);
    // 预先算好它的长度平方，避免每次投影重复开方
    const mouseBALenSq = _mouseBA.lengthSq();
    // 记录本帧鼠标位置给下一帧求速度
    _mousePrev.copy(_mouse);

    // 物理体数组短引用
    const bodies = this.bodies;
    // 数量
    const n = bodies.length;

    // 依次积分每颗球
    for (let a = 0; a < n; a++) {
      // 当前球
      const body = bodies[a];
      // ① 先施加向心重力（会修改 body.velocity）
      body.updateGravity(dt);

      // 把速度和位置拷到临时向量上进行本帧计算（避免频繁读写对象属性）
      _vel.copy(body.velocity);
      _pos.copy(body.position);

      // —— 两两碰撞 ——
      // 只与索引更大的球配对，保证每对只处理一次
      for (let b = a + 1; b < n; b++) {
        // 另一颗球
        const other = bodies[b];
        // 拷贝对方速度/位置到临时向量
        _velB.copy(other.velocity);
        _posB.copy(other.position);

        // 法线方向 = 当前位置差（由 B 指向 A）
        _normal.copy(_pos).sub(_posB);
        // 球心距离
        const dist = _normal.length();
        // 恰好接触的最小距离
        const minDist = body.radius + other.radius;
        // 未接触则跳过
        if (dist >= minDist) continue;

        // 摩擦取两球几何平均，双方共同累积
        const frictionAvg = Math.sqrt(body.friction * other.friction);
        // 双方 frictionTot 都加上，之后的重力会被削弱
        body.frictionTot += frictionAvg;
        other.frictionTot += frictionAvg;

        // 把法线缩放为"重叠量的一半"（dist-minDist 为负 → 反向分离）
        _normal.normalize().multiplyScalar(0.5 * (dist - minDist));
        // A 沿法线推出（各承担一半重叠）
        _pos.sub(_normal);
        // B 反向推出
        _posB.add(_normal);
        // 缩放后再归一化，得到纯单位法线供速度分解
        _normal.normalize();

        // 沿法线的速度分量（标量）
        const velA = _vel.dot(_normal);
        const velB = _velB.dot(_normal);
        // 质量
        const mA = body.mass;
        const mB = other.mass;
        // 恢复系数（弹性）
        const rA = body.restitution;
        const rB = other.restitution;

        // 一维弹性碰撞公式：A 沿法线的新速度
        const newA = (mA * velA + mB * velB - mB * (velA - velB) * rA) / (mA + mB);
        // 同理得 B 的新速度（推导符号相反）
        const newB = (mA * velA + mB * velB - mA * (velB - velA) * rB) / (mA + mB);

        // 把速度变化量沿法线加回去（再除以 (1+摩擦) 做阻尼）
        _vel.addScaledVector(_normal, (newA - velA) / (1 + frictionAvg));
        _velB.addScaledVector(_normal, (newB - velB) / (1 + frictionAvg));

        // 对方的位移与速度直接写回物理体（A 稍后统一写回）
        other.position.copy(_posB);
        other.velocity.copy(_velB);
      }

      // —— 鼠标推挤 ——
      // 相机 → 球心 向量
      _v0.copy(_pos).sub(camera.position);
      // 把球心投影到"相机→鼠标"射线上，得到投影比例 c
      let c = _v0.dot(_mouseBA) / mouseBALenSq;
      // 用 _velB 复用：投影点 = 射线方向 × c；再算 球心到投影点距离 - 球半径 - 鼠标半径
      c = _v0.sub(_velB.copy(_mouseBA).multiplyScalar(c)).length() - body.radius - MOUSE_RADIUS;

      // c < 0 表示球与鼠标"射线管"相交，且指针确实在画面内
      if (hasPointer && c < 0) {
        // 构造垂直方向：相机→球 与 相机→鼠标 叉乘，得到从鼠标指向球的推力方向
        _v0.copy(_pos).sub(camera.position).cross(_mouseBA).normalize();
        // 再叉乘一次得到实际的分离方向（与射线垂直）
        _v1.copy(_mouseBA).cross(_v0).normalize();
        // 按穿透深度 c 把球推开（c 为负，负负得正 → 向外）
        _pos.sub(_v1.multiplyScalar(MOUSE_INFLUENCE * c));
        // 把同一方向换算成速度推力（除以 dt 使推力与帧率无关）
        _v1.multiplyScalar(-MOUSE_PUSH_FORCE / dt);
        // 叠加到球速度
        _vel.add(_v1);
        // 再叠加鼠标自身的运动速度，把球"甩"出去
        _vel.add(_mousePushForce);
      }

      // —— 自转扰动（离原点越近转得越明显，奇偶球反向）——
      // 球到原点距离
      const posLen = _pos.length();
      // 距离为 0 时无方向，跳过
      if (posLen > 0) {
        // 位置方向与固定斜轴的夹角余弦 → 越接近 0（垂直）扰动越大
        const align = 1 - Math.abs(_axis.dot(_v1.copy(_pos).normalize()));
        // 基础角度：对齐度 × dt × 距离衰减(fit) × 0.5
        let angle = align * dt * fit(posLen, 0, 2, 0, 1) * 0.5;
        // 奇数球取正、偶数球取反 → 相邻球反向旋转，避免整体同向抖动
        angle *= (a % 2) * 2 - 1;
        // 用固定斜轴和角度构造旋转四元数
        _quat.setFromAxisAngle(_axis, angle);
        // 对位置施加该旋转，再减去原位置 → 得到位移扰动向量（_v0 先存原位置）
        _v1.copy(_pos).applyQuaternion(_quat).sub(_v0.copy(_pos));
        // 把扰动当速度叠加，形成轻微摆动
        _vel.add(_v1);
      }

      // —— 力矩 → 四元数（position × velocity）——
      // 角动量方向 ≈ 位置 × 速度（叉乘）
      _v0.crossVectors(_pos, _vel);
      // 角速度大小 = 角动量长度 / 转动惯量
      let spin = _v0.length() / body.inertia;
      // 有角速度才旋转
      if (spin > 0) {
        // 归一化得到旋转轴
        _v0.normalize();
        // 轴角 → 本帧增量四元数（乘 dt 使转速与帧率无关）
        _quat.setFromAxisAngle(_v0, spin * dt);
        // premultiply：在世界空间左乘，使旋转叠加在当前朝向上
        body.quaternion.premultiply(_quat);
      }

      // 本帧临时计算结果写回物理体
      body.position.copy(_pos);
      body.velocity.copy(_vel);
      // ② 位置积分 + 速度阻尼（放在最后，保证碰撞用的是同一时刻的位置）
      body.integrate(dt);
    }
  }
}
