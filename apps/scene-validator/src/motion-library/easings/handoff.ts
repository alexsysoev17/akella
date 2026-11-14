/** C1 arrival: retain the authored curve before join, then Hermite to its endpoint.
 * Slopes are normalized progress / normalized time, not pixels or frame deltas. */
export function handoffProgress(t: number, join: number, value: number, incoming: number, outgoing: number) {
  const width = 1 - join, u = (t - join) / width;
  return (2*u**3-3*u*u+1)*value + (u**3-2*u*u+u)*width*incoming
    + (-2*u**3+3*u*u) + (u**3-u*u)*width*outgoing;
}
export function curveSlope(sample: (t:number)=>number, t:number) {
  const h=1e-5;
  if(t>=1-h)return (3*sample(1)-4*sample(1-h)+sample(1-2*h))/(2*h);
  if(t<=h)return (-3*sample(0)+4*sample(h)-sample(2*h))/(2*h);
  return (sample(t+h)-sample(t-h))/(2*h);
}

/** Acceleration in normalized progress/time², with one-sided endpoint samples. */
export function curveAcceleration(sample:(t:number)=>number,t:number){
  const h=1e-4;
  if(t<=h)return (2*sample(t)-5*sample(t+h)+4*sample(t+2*h)-sample(t+3*h))/(h*h);
  if(t>=1-h)return (2*sample(t)-5*sample(t-h)+4*sample(t-2*h)-sample(t-3*h))/(h*h);
  return (sample(t+h)-2*sample(t)+sample(t-h))/(h*h);
}
/** Quintic Hermite matches position, velocity AND acceleration at both ends. */
export function accelerationBridge(join:number,value:number,v0:number,v1:number,a0:number,a1:number){
  const w=1-join,c0=value,c1=w*v0,c2=w*w*a0/2;
  const d=1-c0-c1-c2,v=w*v1-c1-2*c2,a=w*w*a1-2*c2;
  const c3=10*d-4*v+a/2,c4=-15*d+7*v-a,c5=6*d-3*v+a/2;
  return (t:number)=>{
    const u=(t-join)/w;
    return {value:c0+u*(c1+u*(c2+u*(c3+u*(c4+u*c5)))),
      velocity:(c1+u*(2*c2+u*(3*c3+u*(4*c4+u*5*c5))))/w,
      acceleration:(2*c2+u*(6*c3+u*(12*c4+u*20*c5)))/(w*w),
      jerk:(6*c3+u*(24*c4+u*60*c5))/(w*w*w)};
  };
}

/** One rest-to-arrival trajectory; C3 at launch and at the oscillator handoff.
 * No small end-of-track correction patch. All coefficients describe the approach. */
export function continuousArrival(t:number,velocity:number,acceleration:number,jerk:number){
  const c4=35-15*velocity+2.5*acceleration-jerk/6;
  const c5=-84+39*velocity-7*acceleration+jerk/2;
  const c6=70-34*velocity+6.5*acceleration-jerk/2;
  const c7=-20+10*velocity-2*acceleration+jerk/6;
  return {value:t**4*(c4+t*(c5+t*(c6+t*c7))),
    velocity:t**3*(4*c4+t*(5*c5+t*(6*c6+t*7*c7))),
    acceleration:t*t*(12*c4+t*(20*c5+t*(30*c6+t*42*c7))),
    jerk:t*(24*c4+t*(60*c5+t*(120*c6+t*210*c7)))};
}
