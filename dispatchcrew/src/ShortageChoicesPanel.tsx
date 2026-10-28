import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { money, type ShortageChoices, type ShortageSelection } from '../shared/types';
import { Spinner } from './components';

export function ShortageChoicesPanel({quote,currentTotal,busy,onApply}:{quote:ShortageChoices;currentTotal:number;busy:boolean;onApply:(selections:ShortageSelection[])=>Promise<void>}) {
  const [selected,setSelected]=useState<Record<string,string>>({});
  const choices=quote.issues.map(issue=>issue.options.find(option=>option.id===selected[issue.productId]));
  const complete=choices.every(Boolean);
  const proposedTotal=currentTotal+choices.reduce((sum,option)=>sum+(option?.priceDifference||0),0);
  if(!quote.issues.length) return <p className="shortage-availability-note">Stock availability has changed. Ask the warehouse team to recheck this order.</p>;
  return <form className="shortage-choice-form" onSubmit={event=>{event.preventDefault();if(complete)void onApply(quote.issues.map(issue=>({originalProductId:issue.productId,optionId:selected[issue.productId]})));}}>
    <h3>Choose a way forward.</h3>
    <p>Use the available quantity, choose an approved alternative, or remove the short item. Changes require your confirmation and warehouse approval.</p>
    {quote.issues.map((issue,index)=>{
      const choice=choices[index];
      return <div className="shortage-choice" key={issue.productId}><label>
        {issue.name}<small>{issue.requested} requested · current line total {money(issue.currentTotal)}</small>
        <select aria-label={`Choose for ${issue.name}`} required disabled={busy} value={selected[issue.productId]||''} onChange={event=>setSelected(previous=>({...previous,[issue.productId]:event.target.value}))}>
          <option value="">Choose an option</option>
          {issue.options.map(option=><option value={option.id} key={option.id}>{option.kind==='remove'?`Remove ${issue.name}`:option.kind==='reduce'?`Reduce to ${option.quantity} units · ${money(option.total)}`:`${option.quantity} × ${option.name} · ${money(option.total)}`}</option>)}
        </select>
      </label>{choice&&<div className="shortage-choice-explanation"><p>{choice.explanation}</p><span>New line total: <b>{money(choice.total)}</b> · {choice.priceDifference>0?'+':''}{money(choice.priceDifference)} change</span></div>}</div>;
    })}
    {complete&&<div className="shortage-proposed-total"><span>Proposed order total</span><strong>{money(proposedTotal)}</strong></div>}
    <button className="button primary full" disabled={busy||!complete}>{busy?<Spinner/>:<>Review updated order<ArrowRight size={16}/></>}</button>
    <p className="form-note">No stock is reserved yet. Removed quantities are not backordered.</p>
  </form>;
}
