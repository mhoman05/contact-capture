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
  const n:any={getDatabase:async(id:string)=>id==='books'?schema(['Name','Author','Library ID','Library link','Format','Status','App notes']):schema(['Name','Book','Idea','Source','Source key','Library link']),queryPage:async(id:string)=>({results:id==='books'?[book]:[idea],has_more:false,next_cursor:null}),updatePage:async(id:string,p:any)=>{writes.push({id,p});return {id,properties:p};},createPage:async()=>{throw Error('Must adopt initial rows');},archivePage:async()=>{throw Error('Must not delete');}};
  const r=await exportLibrary(n,'books','ideas',[b]);expect(r.books_updated).toBe(1);expect(r.takeaways_updated).toBe(1);expect(writes[1].id).toBe('idea1');
  for(const w of writes){expect(w.p).not.toHaveProperty('Personal notes');expect(w.p).not.toHaveProperty('Action');expect(w.p).not.toHaveProperty('Topics');}
 });
 it('rejects over-budget requests before any reads or writes',async()=>{
  let calls=0;const n:any={getDatabase:async()=>{calls++;throw Error('not reached');}};
  await expect(exportLibrary(n,'books','ideas',[b,b])).rejects.toThrow('one book');
  await expect(exportLibrary(n,'books','ideas',[{...b,ideas:Array.from({length:6},(_,i)=>({key:'key'+i,text:'idea'}))}])).rejects.toThrow('five');expect(calls).toBe(0);
 });
 it('stops incomplete scoped pagination before writing',async()=>{
  let lookups=0,writes=0;const schema=(keys:string[])=>({properties:Object.fromEntries(keys.map(k=>[k,{}]))});
  const n:any={getDatabase:async(id:string)=>id==='books'?schema(['Name','Author','Library ID','Library link','Format','Status','App notes']):schema(['Name','Book','Idea','Source','Source key','Library link']),queryPage:async()=>{lookups++;return {results:[],has_more:true,next_cursor:'next'};},createPage:async()=>writes++,updatePage:async()=>writes++};
  await expect(exportLibrary(n,'books','ideas',[b])).rejects.toThrow('Too many matching');expect(lookups).toBe(4);expect(writes).toBe(0);
 });
 it('checks both destinations before writing',async()=>{let writes=0;const n:any={getDatabase:async()=>({properties:{}}),updatePage:async()=>writes++,createPage:async()=>writes++};await expect(exportLibrary(n,'books','ideas',[b])).rejects.toThrow('schema');expect(writes).toBe(0);});
});
