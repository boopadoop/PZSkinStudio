// A colour for each object of a model, for telling their UV lines apart. Golden-angle steps round the
// colour wheel keep neighbours far apart however many objects there are.
export function partRgb(part) {
  const h = ((part * 137.508) % 360) / 360;
  const [s, l] = [0.85, 0.62];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    const k = (t + 1) % 1;
    if (k < 1 / 6) return p + (q - p) * 6 * k;
    if (k < 1 / 2) return q;
    if (k < 2 / 3) return p + (q - p) * (2 / 3 - k) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)].map((c) => Math.round(c * 255));
}

export const partCss = (part, alpha = 1) => `rgba(${partRgb(part).join(', ')}, ${alpha})`;
