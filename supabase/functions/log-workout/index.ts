import { createClient } from "npm:@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-workout-token",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {status, headers: {...corsHeaders, "Content-Type": "application/json"}});
}
function getSecretKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (legacy) return legacy;
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      if (typeof keys === "string") return keys;
      if (keys.default) return keys.default;
      for (const value of Object.values(keys)) {
        if (typeof value === "string") return value;
      }
    } catch {}
  }
  return null;
}
function authorized(req: Request) {
  const expected = Deno.env.get("WORKOUT_INGEST_TOKEN");
  return Boolean(expected && req.headers.get("x-workout-token") === expected);
}
Deno.serve(async (req) => {
  if(req.method === 'OPTIONS') return new Response('ok',{headers:corsHeaders});
  const url=new URL(req.url);
  if(req.method==='GET'&&url.searchParams.get('recent')!=='1') return new Response(null,{status:302,headers:{Location:'https://malikyaah.github.io/portfolio/sport.html','Cache-Control':'no-store'}});
  if(!['GET','POST','PATCH'].includes(req.method)) return json({error:'method_not_allowed'},405);
  if(!authorized(req)) return json({error:'unauthorized'},401);
  const key=getSecretKey(),supabaseUrl=Deno.env.get('SUPABASE_URL');
  if(!key||!supabaseUrl) return json({error:'server_configuration_error'},500);
  const db=createClient(supabaseUrl,key),columns='id,performed_at,session_name,exercise,set_number,reps,reps_left,reps_right,weight_kg,rpe,notes,client_set_id';
  if(req.method==='GET'){
    const limit=Number(url.searchParams.get('limit')||100),before=url.searchParams.get('before_id');
    if(!Number.isInteger(limit)||limit<1||limit>500||before&&!/^\d+$/.test(before))return json({error:'invalid_pagination'},400);
    let query=db.from('workout_sets').select(columns).order('id',{ascending:false});
    if(before)query=query.lt('id',before);
    const {data,error}=await query.limit(limit+1);
    if(error)return json({error:error.message},500);
    const rows=data.slice(0,limit);
    return json({api_version:2,data:rows,next_cursor:data.length>limit?String(rows[rows.length-1].id):null});
  }
  let body;try{body=await req.json()}catch{return json({error:'invalid_json'},400)}
  if(!body||typeof body!=='object'||Array.isArray(body))return json({error:'invalid_body'},400);
  const isPatch=req.method==='PATCH';
  if(isPatch&&!/^\d+$/.test(String(body.id||'')))return json({error:'invalid_id'},400);
  let previous=null;
  if(isPatch){const result=await db.from('workout_sets').select('*').eq('id',body.id).maybeSingle();if(result.error)return json({error:result.error.message},500);if(!result.data)return json({error:'not_found'},404);previous=result.data}
  const b={...(previous||{}),...body};
  const number=v=>v===null||v===undefined||v===''?null:typeof v==='number'||typeof v==='string'?Number(String(v).replace(',','.')):NaN;
  const reps=number(b.reps),left=number(b.reps_left),right=number(b.reps_right),weight=number(b.weight_kg),rpe=number(b.rpe),setNumber=number(b.set_number??1);
  const repOk=v=>Number.isFinite(v)&&v>=0&&Number.isInteger(v*2);
  if(typeof b.exercise!=='string'||!b.exercise.trim())return json({error:'exercise_required'},400);
  if(!Number.isInteger(setNumber)||setNumber<1)return json({error:'invalid_set_number'},400);
  const unilateral=left!==null||right!==null;
  if(unilateral?(!repOk(left)||!repOk(right)||reps!==null):!repOk(reps))return json({error:'invalid_reps'},400);
  if(weight!==null&&(!Number.isFinite(weight)||weight<0))return json({error:'invalid_weight'},400);
  if(rpe!==null&&(!Number.isFinite(rpe)||rpe<0||rpe>10))return json({error:'invalid_rpe'},400);
  for(const field of ['session_name','notes'])if(b[field]!=null&&typeof b[field]!=='string')return json({error:'invalid_'+field},400);
  if(b.client_set_id!=null&&(typeof b.client_set_id!=='string'||b.client_set_id.length>100||!b.client_set_id.trim()))return json({error:'invalid_client_set_id'},400);
  if(isPatch&&body.client_set_id!=null&&previous.client_set_id&&body.client_set_id!==previous.client_set_id)return json({error:'immutable_client_set_id'},400);
  const row={session_name:b.session_name||null,exercise:b.exercise.trim(),set_number:setNumber,reps,reps_left:left,reps_right:right,weight_kg:weight,rpe,notes:b.notes||null,client_set_id:b.client_set_id||null};
  if(!isPatch){const date=b.performed_at?new Date(b.performed_at):new Date();if(!Number.isFinite(date.getTime()))return json({error:'invalid_performed_at'},400);Object.assign(row,{performed_at:date.toISOString(),source:'sport-app'})}
  let result;
  if(isPatch)result=await db.from('workout_sets').update(row).eq('id',body.id).select(columns).single();
  else{
    result=await db.from('workout_sets').insert(row).select(columns).single();
    // A queued request may have reached the server before its response was lost.
    if(result.error?.code==='23505'&&row.client_set_id)result=await db.from('workout_sets').select(columns).eq('client_set_id',row.client_set_id).single();
  }
  if(result.error)return json({error:result.error.message},500);
  return json({ok:true,api_version:2,data:result.data});
});