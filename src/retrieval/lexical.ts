const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const stop=new Set(['的','了','是','在','和','与','或','我','你','它','怎么','怎样','如何','什么','是否','这个','那个','之前','以前','需要','应该','可以','不能','项目','处理','问题','约定','安排','一下','一个','我们','要','能','用']);
export function terms(text:string) {
  return [...new Set([...segmenter.segment(text)].filter(x=>x.isWordLike).map(x=>x.segment.toLowerCase()).filter(x=>!stop.has(x)))];
}
export function lexicalCoverage(query:string,body:string) {
  const q=terms(query),document=new Set(terms(body));
  return q.length?q.filter(x=>document.has(x)).length/q.length:0;
}
export function identifiers(text:string) {
  const found=text.match(/(?:\.?\.?\/|\/)?(?:[\w.\-\u4e00-\u9fff]+\/)+[\w.\-\u4e00-\u9fff]+|@[\w-]+\/[\w.-]+|[\w-]+\.[\w.-]+|(?:ERR_|E[A-Z_]{2,})[A-Z_0-9]*|-?\d{4,}|[a-zA-Z][a-zA-Z0-9]*[-_][a-zA-Z0-9_-]+|[a-zA-Z_$][\w$]*(?=\s*\()/g)??[];
  return [...new Set(found.map(x=>x.toLowerCase()))];
}
export function identifierWeights(title:string,content:string,tags:string[]) {
  const weights=new Map<string,number>();
  for(const [value,weight]of [[content,1],[tags.join(' '),2],[title,3]] as const)for(const id of identifiers(value))weights.set(id,Math.max(weights.get(id)??0,weight));
  return weights;
}
export function ftsQuery(text:string) { return terms(text).slice(0,100).map(x=>'"'+x.replaceAll('"','""')+'"').join(' OR '); }
export function exactScore(query:string,title:string,content:string,tags:string[]) {
  let score=0;
  for(const id of identifiers(query)) {
    const boundary='(^|[^\\p{L}\\p{N}_./@-])'+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|[^\\p{L}\\p{N}_./@-])';
    const re=new RegExp(boundary,'iu');
    if(re.test(title)) score+=3;
    else if(tags.some(x=>re.test(x))) score+=2;
    else if(re.test(content)) score+=1;
  }
  return score;
}
