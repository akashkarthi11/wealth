export const DEFAULT_SCHEDULE_TIME = '09:48';
export const SCHEDULE_TIMEZONE = 'Asia/Kolkata';
export const DAILY_POLL_WINDOW = '18:45 IST central dispatcher';
export const MAX_SCHEDULE_TIME = '09:48';

function partsAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    weekday:'short', hourCycle:'h23'
  }).formatToParts(date);
  const out = Object.fromEntries(parts.map(p=>[p.type,p.value]));
  return {
    year:Number(out.year), month:Number(out.month), day:Number(out.day),
    hour:Number(out.hour), minute:Number(out.minute), second:Number(out.second),
    weekday:out.weekday
  };
}

function localDateKey(y,m,d) {
  return String(y).padStart(4,'0')+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
}
function addCalendarDays(y,m,d,days) {
  const dt=new Date(Date.UTC(y,m-1,d+days));
  return {year:dt.getUTCFullYear(),month:dt.getUTCMonth()+1,day:dt.getUTCDate()};
}
function weekdayFor(y,m,d) {
  return new Date(Date.UTC(y,m-1,d)).getUTCDay();
}
export function zonedDateTimeToUtc({year,month,day,hour,minute},timeZone=SCHEDULE_TIMEZONE) {
  const target=Date.UTC(year,month-1,day,hour,minute,0,0);
  let guess=target;
  for(let i=0;i<5;i++) {
    const p=partsAt(new Date(guess),timeZone);
    const represented=Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second,0);
    const delta=target-represented;
    if(delta===0)break;
    guess+=delta;
  }
  return new Date(guess);
}
export function getLocalDateTime(date=new Date(),timeZone=SCHEDULE_TIMEZONE) {
  const p=partsAt(date,timeZone);
  return {...p,date:localDateKey(p.year,p.month,p.day),time:String(p.hour).padStart(2,'0')+':'+String(p.minute).padStart(2,'0')};
}
export function isValidScheduleTime(value) {
  return typeof value==='string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) && value<=MAX_SCHEDULE_TIME;
}
export function isEligibleScheduleDate(dateKey,frequency='daily') {
  const [y,m,d]=String(dateKey).split('-').map(Number);
  if(!y||!m||!d)return false;
  const day=weekdayFor(y,m,d);
  return frequency==='daily' || (frequency==='weekdays' && day>=1 && day<=5);
}
export function nextScheduledAt(now=new Date(),scheduleTime=DEFAULT_SCHEDULE_TIME,frequency='daily',timeZone=SCHEDULE_TIMEZONE) {
  if(!isValidScheduleTime(scheduleTime))throw new Error('Schedule time must be between 00:00 and 09:48 IST; the central dispatcher runs daily at 18:45 IST.');
  if(!['daily','weekdays'].includes(frequency))throw new Error('Frequency must be daily or weekdays.');
  const local=getLocalDateTime(now,timeZone);
  let date={year:local.year,month:local.month,day:local.day};
  if(local.time>=scheduleTime)date=addCalendarDays(date.year,date.month,date.day,1);
  for(let i=0;i<8;i++) {
    const key=localDateKey(date.year,date.month,date.day);
    if(isEligibleScheduleDate(key,frequency)) {
      return zonedDateTimeToUtc({...date,hour:Number(scheduleTime.slice(0,2)),minute:Number(scheduleTime.slice(3,5))},timeZone);
    }
    date=addCalendarDays(date.year,date.month,date.day,1);
  }
  throw new Error('Could not calculate the next scheduled date.');
}
export function dueScheduleDates(now=new Date(),lastScheduledDate=null,scheduleTime=DEFAULT_SCHEDULE_TIME,frequency='daily',timeZone=SCHEDULE_TIMEZONE,maxCatchup=3) {
  if(!isValidScheduleTime(scheduleTime))return [];
  const local=getLocalDateTime(now,timeZone);
  if(local.time<scheduleTime)return [];
  const [y,m,d]=lastScheduledDate?String(lastScheduledDate).slice(0,10).split('-').map(Number):[local.year,local.month,local.day-1];
  let cursor=addCalendarDays(y,m,d,1);
  const dates=[];
  for(let i=0;i<14 && dates.length<maxCatchup;i++) {
    const key=localDateKey(cursor.year,cursor.month,cursor.day);
    if(key>local.date)break;
    if(isEligibleScheduleDate(key,frequency))dates.push(key);
    cursor=addCalendarDays(cursor.year,cursor.month,cursor.day,1);
  }
  return dates;
}
export function formatScheduleTime(date,timeZone=SCHEDULE_TIMEZONE) {
  return new Intl.DateTimeFormat('en-IN',{timeZone,dateStyle:'medium',timeStyle:'short'}).format(date);
}
