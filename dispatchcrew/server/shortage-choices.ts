import { createHash } from 'node:crypto';
import type { Line, Product, ShortageChoices, ShortageOption } from '../shared/types';

export interface Substitution { productId: string; replacementId: string; reason: string }
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Deterministic catalogue policy: a model cannot invent substitutes or prices.
export function buildShortageChoices(orderId: string, version: number, lines: Line[], products: Product[], substitutions: Substitution[]): ShortageChoices {
  const catalogue = new Map(products.map(product => [product.id, product]));
  const grouped = new Map<string, { quantity: number; total: number }>();
  for (const line of lines) {
    if (!line.productId || !line.quantity) continue;
    const previous = grouped.get(line.productId) || { quantity: 0, total: 0 };
    grouped.set(line.productId, { quantity: previous.quantity + line.quantity, total: previous.total + line.total });
  }
  const policy = substitutions.filter(s => grouped.has(s.productId)).sort((a,b)=>`${a.productId}:${a.replacementId}`.localeCompare(`${b.productId}:${b.replacementId}`));
  const relevantIds = new Set([...grouped.keys(), ...policy.map(s=>s.replacementId)]);
  const stock = products.filter(p=>relevantIds.has(p.id)).sort((a,b)=>a.id.localeCompare(b.id)).map(({id, name, price, available})=>({id,name,price,available}));
  const quoteId = fingerprint({ orderId, version, lines: lines.map(({index,productId,name,quantity,unitPrice,total})=>({index,productId,name,quantity,unitPrice,total})), stock, policy });
  const issues: ShortageChoices['issues'] = [];
  for (const [productId, demand] of grouped) {
    const product = catalogue.get(productId);
    if (!product || demand.quantity <= product.available) continue;
    const options: ShortageOption[] = [];
    const add = (kind: ShortageOption['kind'], replacement: Product | null, quantity: number, explanation: string) => {
      const total = quantity * (replacement?.price || 0);
      const option = { kind, productId: replacement?.id || null, name: replacement?.name || product.name, quantity, unitPrice: replacement?.price || 0, total, priceDifference: total-demand.total, explanation };
      options.push({id:fingerprint(option), ...option});
    };
    if (product.available > 0) add('reduce', product, product.available, `Reduce ${product.name} from ${demand.quantity} to ${product.available} units. The remaining units will not be backordered.`);
    for (const rule of policy.filter(s=>s.productId===productId)) {
      const replacement = catalogue.get(rule.replacementId);
      if (!replacement) continue;
      const remaining = replacement.available - (grouped.get(replacement.id)?.quantity || 0);
      const quantity = Math.min(demand.quantity, remaining);
      if (quantity > 0) add('substitute', replacement, quantity, `${rule.reason}${quantity < demand.quantity ? ` Only ${quantity} of the requested ${demand.quantity} units fit the current stock; the rest will not be backordered.` : ''}`);
    }
    add('remove', null, 0, `Remove all ${demand.quantity} units of ${product.name} from this order. No backorder will be created.`);
    issues.push({productId,name:product.name,requested:demand.quantity,currentTotal:demand.total,options});
  }
  return {quoteId,version,issues};
}
