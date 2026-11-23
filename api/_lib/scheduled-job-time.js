const TZ='Asia/Kolkata';

function localParts(date,timezone=TZ) {
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',weekday:'short'}).formatToParts(date);
  return Object.fromEntries(p.map(x=>[x.type,x.value]));
}
function zonedTimeToUtc(year,month,day,hour,minute,timezone) {
  const target=Date.UTC(year,month-1,day,hour,minute);
  let guess=target;
  for(let i=0;i<3;i++){
    const p=localParts(new Date(guess),timezone);
    const represented=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),Number(p.hour),Number(p.minute));
    guess+=target-represented;
  }
  return new Date(guess);
}
export function nextJobRun(now,time,frequency='daily',timezone=TZ) {
  const [hour,minute]=String(time).slice(0,5).split(':').map(Number);
  const base=localParts(now,timezone);
  for(let offset=0;offset<9;offset++){
    const d=new Date(Date.UTC(Number(base.year),Number(base.month)-1,Number(base.day)+offset));
    const weekday=new Intl.DateTimeFormat('en-US',{timeZone:timezone,weekday:'short'}).format(d);
    if(frequency==='weekdays'&&['Sat','Sun'].includes(weekday))continue;
    const candidate=zonedTimeToUtc(d.getUTCFullYear(),d.getUTCMonth()+1,d.getUTCDate(),hour,minute,timezone);
    if(candidate>now)return candidate;
  }
  throw new Error('Could not calculate the next scheduled run.');
}
