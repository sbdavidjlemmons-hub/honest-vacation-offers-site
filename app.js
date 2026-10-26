(function(){
  'use strict';
  var cfg=window.HVO_CONFIG;
  var keys=['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid'];
  var params=new URLSearchParams(window.__hvmParams||location.search);
  var attribution={};
  try{attribution=JSON.parse(localStorage.getItem('hvm_attr')||'{}')||{};}catch(_){}
  if(!keys.some(function(k){return attribution[k];})){
    keys.forEach(function(k){var v=params.get(k);if(v)attribution[k]=v.slice(0,200);});
    try{localStorage.setItem('hvm_attr',JSON.stringify(attribution));}catch(_){}
  }
  // Page views are emitted once by the shared tracking head. These events
  // represent interactions only: a calendar click is NOT a confirmed booking.
  function track(name,extra){
    var data=Object.assign({offer_family:(window.HVM_PAGE||{}).family||'all'},extra||{});
    if(typeof window.gtag==='function')window.gtag('event',name,data);
    if(typeof window.fbq==='function'){
      if(name==='generate_lead')window.fbq('track','Lead',{content_name:data.offer_family});
      else window.fbq('trackCustom',name,data);
    }
  }
  document.querySelectorAll('[data-booking]').forEach(function(a){
    var u=new URL(cfg.booking);
    keys.forEach(function(k){if(attribution[k])u.searchParams.set(k,attribution[k]);});
    a.href=u.href;
    a.addEventListener('click',function(){track('booking_click');});
  });
  document.querySelectorAll('a[href^="tel:"]').forEach(function(a){a.addEventListener('click',function(){track('phone_click');});});
  document.querySelectorAll('a[href^="/"]').forEach(function(a){a.addEventListener('click',function(){
    var path=a.getAttribute('href');
    if(/^\/(cruise|all-inclusive|condo|resort-air)\.html$/.test(path))track('offer_click',{destination_page:path});
  });});
  var form=document.getElementById('interest-form');if(!form)return;
  var offerSelect=form.elements.offer;
  if((window.HVM_PAGE||{}).family)offerSelect.value=window.HVM_PAGE.family;
  var referral=form.elements.referral;
  referral.value=params.get('referral_code')||attribution.utm_content||'';
  var started=false;form.addEventListener('input',function(){if(!started){started=true;track('form_start');}},{passive:true});
  var busy=false;
  form.addEventListener('submit',async function(e){
    e.preventDefault();if(busy||!form.reportValidity()||form.elements.company_website.value)return;
    var status=document.getElementById('form-status'),button=form.querySelector('button[type="submit"]');
    busy=true;button.disabled=true;button.textContent='SENDING…';status.textContent='';
    var attr=Object.assign({},attribution),code=referral.value.trim();
    if(code)attr.utm_content=code;
    var body={net:'net1',bucket:'interest-review',offer:offerSelect.value,page:location.pathname,
      firstName:form.elements.firstName.value.trim(),email:form.elements.email.value.trim(),
      mobile:form.elements.mobile.value.trim(),qualified:false,
      consent:false,consentVersion:'hvo-interest-v1',emailPermission:'form-submitted',
      smsPermission:'none',callPermission:'none',source:'honest-vacation-offers',
      campaign:attr.utm_campaign||'hvo-website',whiteLabel:'Honest Vacation Offers',whiteLabelCode:'HVO',
      attribution:attr,sourceUrl:location.origin+location.pathname,
      notes:'Requested vacation information by email. Referral code: '+(code||'(none)')+'. No SMS or outbound call consent captured.'};
    var abort=new AbortController(),timer=setTimeout(function(){abort.abort();},12000);
    try{
      var response=await fetch(cfg.intake,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:abort.signal});
      var result=await response.json().catch(function(){return {};});
      if(!response.ok||result.ok!==true||result.tagged!==true)throw Error('Request not confirmed');
      status.textContent='Your interest was received. To reserve a presentation time, complete your booking in the calendar. No appointment has been booked yet.';
      track('generate_lead',{offer_family:offerSelect.value});
      form.elements.firstName.value='';form.elements.email.value='';form.elements.mobile.value='';
    }catch(_){
      status.textContent='We could not confirm receipt of your request. Please use the booking calendar below, or call '+cfg.phone+'. Your appointment is not booked yet.';
    }finally{clearTimeout(timer);busy=false;button.disabled=false;button.textContent='SEND MY INTEREST ↗';}
  });
})();
