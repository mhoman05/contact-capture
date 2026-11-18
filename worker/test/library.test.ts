import { describe,it,expect } from 'vitest';
import { parseLibrary,exportLibrary } from '../src/index';
const b={id:'book1',title:'A book',author:'Author',formats:['ebook'],status:'',notes:'',ideas:[{key:'book1.guide.0',text:'An existing supplied idea'}]};
const plain=(s:string)=>({rich_text:[{plain_text:s}]});
describe('Library one-way export',()=>{
 it('validates input before writes',()=>{expect(typeof parseLibrary({books:[b,b]})).toBe('string');expect(typeof parseLibrary({books:[{...b,id:'../wrong'}]})).toBe('string');expect(parseLibrary({books:[b]})).toEqual([b]);});
 it('adopts imported rows and never writes personal fields or deletes',async()=>{
  const writes:any[]=[];const book:any={id:'page1',properties:{'Library ID':plain('book1'),'Personal notes':plain('Keep my notes')}};
  const idea:any={id:'idea1',properties:{Book:{relation:[{id:'page1'}]},Idea:plain(b.ideas[0].text),Source:{select:{name:'Supplied guide'}},Action:plain('Keep my action')}};
  const schema=(keys:string[])=>({properties:Object.fromEntries(keys.map(k=>[k,{}]))});
  const n:any={getDatabase:async(id:string)=>id==='books'?schema(['Name','Author','Library ID','Library link','Format','Status','App notes']):schema(['Name','Book','Idea','Source','Source key','Library link']),queryAll:async(id:string)=>id==='books'?[book]:[idea],updatePage:async(id:string,p:any)=>{writes.push({id,p});return {id,properties:p};},createPage:async()=>{throw Error('Must adopt initial rows');},archivePage:async()=>{throw Error('Must not delete');}};
  const r=await exportLibrary(n,'books','ideas',[b]);expect(r.books_updated).toBe(1);expect(r.takeaways_updated).toBe(1);expect(writes[1].id).toBe('idea1');
  for(const w of writes){expect(w.p).not.toHaveProperty('Personal notes');expect(w.p).not.toHaveProperty('Action');expect(w.p).not.toHaveProperty('Topics');}
 });
 it('checks both destinations before writing',async()=>{let writes=0;const n:any={getDatabase:async()=>({properties:{}}),updatePage:async()=>writes++,createPage:async()=>writes++};await expect(exportLibrary(n,'books','ideas',[b])).rejects.toThrow('schema');expect(writes).toBe(0);});
});
