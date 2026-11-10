import {cookie} from '../_lib.js';

export default function handler(req,res){
 if(req.method!=='GET'){
  res.statusCode=405;
  res.setHeader('Allow','GET');
  res.end('Method not allowed');
  return;
 }
 // Clear only this app's HttpOnly login cookie. Financial records are untouched.
 cookie(res,'');
 res.statusCode=303;
 res.setHeader('Location','/');
 res.setHeader('Cache-Control','no-store');
 res.end();
}