import { json } from '../_lib.js';

export default async function handler(req,res) {
  if(req.method!=='GET'&&req.method!=='POST')return json(res,405,{error:'Method not allowed'});
  return json(res,410,{error:'This endpoint is retired. Interest accrual is owned exclusively by /api/nightly.'});
}
