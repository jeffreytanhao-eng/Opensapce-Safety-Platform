/**
 * 字节码加载器（算法源码以 V8 字节码 server.jsc 形式分发，本文件不含业务逻辑）
 * 注意：.jsc 与 Node 大版本绑定，请使用 README 要求的 Node 版本运行。
 */
require('bytenode')
require('./server.jsc')
