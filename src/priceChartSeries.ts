export function averageAt(data: any[], days: number, index: number, field = "close") {
  if (index + 1 < days) return Number.NaN;
  const slice = data.slice(Math.max(0, index - days + 1), index + 1);
  return slice.reduce((sum, item) => sum + Number(item[field] || 0), 0) / days;
}

export function calculatePriceMovingAverages(data: any[]) {
  return {
    ma5: data.map((_: any, index: number) => averageAt(data, 5, index)),
    ma10: data.map((_: any, index: number) => averageAt(data, 10, index)),
    ma20: data.map((_: any, index: number) => averageAt(data, 20, index)),
    ma60: data.map((_: any, index: number) => averageAt(data, 60, index))
  };
}

export function calculateBollingerBands(data: any[], mid: number[], enabled = true) {
  if (!enabled) return { upper: [] as number[], lower: [] as number[] };
  const upper = Array<number>(data.length).fill(Number.NaN);
  const lower = Array<number>(data.length).fill(Number.NaN);
  for (let index = 19; index < data.length; index += 1) {
    const mean = mid[index] ?? Number.NaN;
    let squaredDeviation = 0;
    for (let rowIndex = index - 19; rowIndex <= index; rowIndex += 1) {
      squaredDeviation += (data[rowIndex].close - mean) ** 2;
    }
    const deviation = Math.sqrt(squaredDeviation / 20);
    upper[index] = mean + deviation * 2;
    lower[index] = mean - deviation * 2;
  }
  return { upper, lower };
}
