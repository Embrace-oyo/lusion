/**
 * BufLoader.js — Lusion 自定义 .buf 模型格式解析器
 *
 * 【格式逆向结果】
 * 整个文件结构：
 *
 *   ┌───────────────────────┬──────────────────────────────┬──────────────────┐
 *   │ uint32 LE: headerLen  │ headerLen 字节的 JSON 头      │ 二进制 payload    │
 *   └───────────────────────┴──────────────────────────────┴──────────────────┘
 *
 * JSON 头字段：
 *   {
 *     vertexCount: number,
 *     indexCount:  number,
 *     meshType:    "Mesh",
 *     attributes: [
 *       {
 *         id:             "position" | "normal" | "uv" | "indices" | ...,
 *         needsPack:      boolean,      // 是否量化压缩
 *         componentSize:  1 | 2 | 3 | 4,// 每个顶点几个分量
 *         storageType:    "Float32Array" | "Uint16Array" | "Int16Array" | "Uint8Array",
 *         packedComponents?: [{ from: number, delta: number }]  // 每个分量的反量化参数
 *       },
 *       ...
 *     ]
 *   }
 *
 * payload 里所有 attribute **按声明顺序紧密排列，没有 padding**，每块大小：
 *   (id === 'indices' ? indexCount : vertexCount) * componentSize * BYTES_PER_TYPE
 *
 * 【反量化公式】
 *   value = from + (raw / MAX) * delta
 *   其中 MAX：Uint8=255，Int16=32767，Uint16=65535（Float32 不需要反量化）
 *
 * 已验证：plant.buf 的 payload 175806 字节 = 各属性字节数之和，完全吻合，无对齐填充。
 */

import * as THREE from 'three';

/** storageType 字符串 → TypedArray 构造器 */
// 用 JSON 头里的 storageType 字符串直接查表拿到构造器，
// 这样新增一种类型只需要在这里补一行，解析逻辑无需改动。
const TYPED = {
  Float32Array,
  Uint32Array,
  Int32Array,
  Uint16Array,
  Int16Array,
  Uint8Array,
  Int8Array,
};

/**
 * 各 storageType 的量化范围（用于反量化）
 * 注意：有符号类型必须按 [MIN, MAX] 归一化，而不是 /MAX。
 * Lusion 导出器把 [0,1] 的值写进 Int16 时用的是 (v*65535)-32768，
 * 所以解码必须是 (raw - MIN) / (MAX - MIN)。
 * 用 /32767 会让 daoP 解成 [-1,1]、SN 解成 [-2.9,0.97]，法线/自阴影全乱。
 */
const QUANT_RANGE = {
  Uint8Array: [0, 255],
  Int8Array: [-128, 127],
  Uint16Array: [0, 65535],
  Int16Array: [-32768, 32767],
  Uint32Array: [0, 4294967295],
  Int32Array: [-2147483648, 2147483647],
};

/**
 * 解析 .buf 二进制数据
 *
 * 步骤：
 *  1. 读前 4 字节得到 JSON 头长度，再按该长度解出 JSON 头
 *  2. 从 4 + headerLen 开始，按 attributes 声明顺序逐块切分 payload
 *  3. 对 needsPack 的属性做反量化，还原成 Float32Array
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ vertexCount:number, indexCount:number, meshType:string, attributes:Object }}
 */
export function parseBuf(arrayBuffer) {
  // bytes 用于按字节切片（含 header 文本），view 用于读取二进制整数
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  // 1. 读取 JSON 头长度（小端 uint32）
  // DataView 默认是大端，这里第二个参数 true 明确要求小端 —— 与 Lusion 导出器一致
  const headerLen = view.getUint32(0, true);
  // 头文本固定从第 4 字节开始，长度正好是 headerLen
  const headerText = new TextDecoder('utf-8').decode(bytes.subarray(4, 4 + headerLen));
  const header = JSON.parse(headerText);

  // 元数据：顶点数 / 索引数用于计算每块属性长度，attributes 是属性声明表
  const { vertexCount, indexCount, attributes } = header;

  // 2. 按顺序切分 payload
  // offset 始终指向"下一块属性的起始字节"，每读完一块就整体后移
  let offset = 4 + headerLen;
  const buffers = {};

  for (const attr of attributes) {
    // 查表拿 TypedArray 构造器；未登记的类型直接报错，避免静默解析出错位数据
    const Ctor = TYPED[attr.storageType];
    if (!Ctor) throw new Error(`BufLoader: 不支持的 storageType "${attr.storageType}"`);

    // 索引属性的元素个数是 indexCount，其它顶点属性是 vertexCount
    // 每个元素含 componentSize 个分量（position/normal=3，uv=2，标量属性=1）
    const count = attr.id === 'indices' ? indexCount : vertexCount;
    const total = count * attr.componentSize;

    // 这里必须拷贝：subarray 依赖原 buffer，且需要按类型对齐
    // slice 会复制出一段独立的 ArrayBuffer，保证 TypedArray 从字节 0 对齐开始，
    // 否则在 offset 非元素整数倍时 new Ctor(subarray) 会抛 RangeError
    const src = new Ctor(arrayBuffer.slice(offset, offset + total * Ctor.BYTES_PER_ELEMENT));
    // 读完立即推进偏移，保证属性之间无 padding 的紧密排列能被正确还原
    offset += total * Ctor.BYTES_PER_ELEMENT;

    // 反量化
    // 量化原理：导出时把 [min, max] 的浮点值线性映射到整型的全量程，
    // 解码就是这个映射的逆运算，见下方逐行说明。
    if (attr.needsPack && attr.packedComponents) {
      // 取该整型存储类型的物理范围，例如 Int16 → [-32768, 32767]
      const [min, max] = QUANT_RANGE[attr.storageType];
      // 全量程宽度；有符号类型是 65535，无符号 Uint8 是 255
      const range = max - min;
      // 反量化结果统一用 Float32 承载，因为 shader 侧只接受浮点属性
      const out = new Float32Array(total);
      // packedComponents[c] 描述第 c 个分量的还原参数 { from, delta }
      const comps = attr.packedComponents;
      for (let i = 0; i < count; i++) {
        for (let c = 0; c < attr.componentSize; c++) {
          const p = comps[c];
          // 取出该顶点第 c 个分量的原始整数值
          const raw = src[i * attr.componentSize + c];
          // 反量化公式：value = from + ((raw - min) / range) * delta
          //   (raw - min) / range  → 先把整数归一化到 [0, 1]
          //   * delta              → 缩放到该分量实际的取值范围宽度
          //   + from               → 平移到实际的最小值
          // 注意必须先减 min 再除 range：Lusion 导出器写 Int16 时用了 (v*65535)-32768，
          // 直接 /32767 会让有符号属性的负半轴整体错位（法线、自阴影会全乱）
          out[i * attr.componentSize + c] = p.from + ((raw - min) / range) * p.delta;
        }
      }
      buffers[attr.id] = out;
    } else {
      // 未量化的属性（如 Float32 的 position）直接原样使用
      buffers[attr.id] = src;
    }
  }

  return { vertexCount, indexCount, meshType: header.meshType, attributes: buffers };
}

/**
 * 把 .buf 数据转换成 THREE.BufferGeometry
 *
 * 固定属性按 Three.js 约定命名（position / normal / uv / index），
 * 其余自定义属性（meshId、branchRatio 等）会自动推断分量数并原样挂到 geometry 上。
 *
 * @param {ArrayBuffer} arrayBuffer
 * @returns {THREE.BufferGeometry}
 */
export function bufToGeometry(arrayBuffer) {
  const { vertexCount, attributes } = parseBuf(arrayBuffer);
  const geo = new THREE.BufferGeometry();

  // —— 固定属性：Three.js 内置 shader 依赖这几个标准命名 ——
  if (attributes.position) {
    geo.setAttribute('position', new THREE.BufferAttribute(attributes.position, 3));
  }
  if (attributes.normal) {
    geo.setAttribute('normal', new THREE.BufferAttribute(attributes.normal, 3));
  }
  if (attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(attributes.uv, 2));
  }
  if (attributes.indices) {
    // 有索引 → 直接作为 index buffer，省显存且能复用顶点
    geo.setIndex(new THREE.BufferAttribute(attributes.indices, 1));
  } else {
    // 没有索引 → 按顺序三角化
    // 生成 0,1,2,3... 的隐式索引，等价于「每三个顶点组成一个三角形」
    const idx = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }

  // 额外自定义属性（如 meshId / branchRatio 等）原样挂上，方便 shader 用
  for (const [id, data] of Object.entries(attributes)) {
    // 已经处理过的标准属性跳过
    if (['position', 'normal', 'uv', 'indices'].includes(id)) continue;
    // 分量数 = 数据总长度 / 顶点数；不是整数说明这份数据不是逐顶点的（例如骨骼、索引表），跳过
    const size = data.length / vertexCount;
    if (Number.isInteger(size) && size > 0 && size <= 4) {
      geo.setAttribute(id, new THREE.BufferAttribute(data, size));
    }
  }

  // 缺法线时让 Three.js 用面法线平均出顶点法线，保证光照不塌
  if (!attributes.normal) geo.computeVertexNormals();
  // 预计算包围球：视锥剔除与后续可能的 raycast 都需要它
  geo.computeBoundingSphere();
  return geo;
}

/**
 * 从 URL 加载 .buf 并返回 BufferGeometry
 * @param {string} url — 相对 BASE_URL 或绝对地址
 * @returns {Promise<THREE.BufferGeometry>}
 */
export async function loadBuf(url) {
  const res = await fetch(url);
  // 显式检查 HTTP 状态，否则 404 时 arrayBuffer() 会拿到一段 HTML 文本，报错位置很难定位
  if (!res.ok) throw new Error(`BufLoader: 加载失败 ${url} (${res.status})`);
  const ab = await res.arrayBuffer();
  return bufToGeometry(ab);
}
