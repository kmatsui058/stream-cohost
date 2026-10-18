// 指定した秒数の無音 WAV（24kHz / mono / 16bit。VOICEVOX の既定出力と同じ形式）を作る。
export function silentWav(seconds) {
  const rate = 24000;
  const dataBytes = Math.round(rate * seconds) * 2;
  const b = Buffer.alloc(44 + dataBytes);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}
