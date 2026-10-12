import { Languages } from 'lucide-react';

export function Brand({ demo = false }: { demo?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-symbol"><Languages size={21} strokeWidth={1.7} /></span>
      <div>
        <h1>MacTranslate <span>Pro</span></h1>
        <p>{demo ? 'Sample workspace' : 'Bilingual interpretation workspace'}</p>
      </div>
    </div>
  );
}
