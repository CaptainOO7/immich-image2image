const ALBUM_NAME = "Image2Image References";
const $ = id => document.getElementById(id);
let selectedFile = null, previewUrl = null;
let profileConfig = null, activeProfile = null;
let searchProfile = null, searchInProgress = false;

function setStatus(s,processing=false){
  $("status").textContent=s;
  $("status").classList.toggle("processing",processing);
}
function setBusy(b){$("search").disabled=b||!selectedFile||!activeProfile?.immichUserId;$("choose").disabled=b;$("profile-select").disabled=b||!profileConfig?.profiles?.length;$("dropzone").style.pointerEvents=b?"none":"auto"}

function chooseFile(file){
  if(!file)return;
  if(!file.type||!file.type.startsWith("image/")){setStatus("Please choose a supported image file.");return}
  selectedFile=file;$("filename").textContent=`${file.name||"Pasted image"} · ${Math.round(file.size/1024)} KB`;
  $("drop-title").textContent="Reference image selected";$("drop-subtitle").textContent="Paste or drop another image to replace it";
  if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(file);$("preview").src=previewUrl;$("preview").hidden=false;
  $("search").disabled=!activeProfile?.immichUserId;setStatus(activeProfile?.immichUserId?"Ready to search.":"Select a verified account in Settings before searching.")
}

function pasteImage(e){
  for(const item of (e.clipboardData?.items||[])){
    if(item.type.startsWith("image/")){const f=item.getAsFile();if(f){e.preventDefault();chooseFile(new File([f],`clipboard-reference.${f.type.split("/")[1]||"image"}`,{type:f.type}));return}}
  }
}

document.addEventListener("paste",pasteImage);
$("dropzone").addEventListener("click",()=>$("file-input").click());
$("dropzone").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();$("file-input").click()}});
$("dropzone").addEventListener("dragover",e=>{e.preventDefault();$("dropzone").classList.add("over")});
$("dropzone").addEventListener("dragleave",()=>$("dropzone").classList.remove("over"));
$("dropzone").addEventListener("drop",e=>{e.preventDefault();$("dropzone").classList.remove("over");chooseFile(e.dataTransfer?.files?.[0])});
$("choose").addEventListener("click",()=>$("file-input").click());
$("file-input").addEventListener("change",e=>chooseFile(e.target.files?.[0]));
$("settings").addEventListener("click",()=>chrome.runtime.openOptionsPage());

async function api(path,options={},profile=searchProfile){
  if(!profile?.serverUrl||!profile?.apiKey){
    throw Error("No verified search profile is active. Stopped safely.");
  }

  const r=await fetch(`${profile.serverUrl}/api${path}`,{
    ...options,
    credentials:"omit",
    redirect:"error",
    headers:{"x-api-key":profile.apiKey,...(options.headers||{})}
  });
  const t=await r.text();let b;
  try{b=t?JSON.parse(t):null}catch{b=t}
  if(!r.ok){
    const m=typeof b==="string"?b:(b?.message||b?.error||r.statusText);
    throw Error(`Immich API ${r.status}: ${m}`);
  }
  return b;
}

async function apiKeyIdentity(profile=searchProfile){
  const user=await api("/users/me",{},profile);
  if(!user?.id)throw Error("Immich API-key authentication returned no user ID. Stopped safely.");
  return user;
}

async function browserSessionIdentity(profile=searchProfile){
  if(!profile?.serverUrl){
    throw Error("No search profile is active. Stopped safely.");
  }

  const r=await fetch(`${profile.serverUrl}/api/users/me`,{
    method:"GET",
    credentials:"include",
    cache:"no-store",
    redirect:"error",
    headers:{"Accept":"application/json"}
  });
  if(!r.ok){
    throw Error(`Could not verify the Immich browser session (HTTP ${r.status}). Sign in to Immich at ${profile.serverUrl} and try again.`);
  }
  const user=await r.json();
  if(!user?.id)throw Error("Immich browser session returned no user ID. Stopped safely.");
  return user;
}

async function persistProfileAlbumId(profile, albumId){
  if(!profile?.id||!albumId)throw Error("Cannot save an album without a valid profile and album ID.");

  profileConfig=await updateConfig(latest=>{
    const current=latest.profiles.find(p=>p.id===profile.id);

    if(!current)
      throw Error("The search profile no longer exists. Stopped safely.");

    if(
      current.serverUrl!==profile.serverUrl||
      current.apiKey!==profile.apiKey
    )
      throw Error("The search profile's server or API key changed. Stopped safely.");

    current.albumId=albumId;
  });

  if(activeProfile?.id===profile.id)
    activeProfile={...activeProfile,albumId};

  if(searchProfile?.id===profile.id)
    searchProfile={...searchProfile,albumId};
}

async function findOrCreateAlbum(profile=searchProfile){
  if(!profile?.id)throw Error("No valid search profile for album operations.");

  const albums=await api("/albums?isOwned=true",{},profile);
  if(!Array.isArray(albums))throw Error("Immich returned an unexpected album list.");

  let album=albums.find(a=>a.albumName===ALBUM_NAME);
  if(album?.id){
    if(profile.albumId!==album.id)
      await persistProfileAlbumId(profile,album.id);
    return album.id;
  }

  try{
    album=await api("/albums",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({albumName:ALBUM_NAME})
    },profile);
    if(album?.id){
      await persistProfileAlbumId(profile,album.id);
      return album.id;
    }
  }catch(createError){
    const refreshed=await api("/albums",{},profile);
    if(Array.isArray(refreshed)){
      const concurrentAlbum=refreshed.find(a=>a.albumName===ALBUM_NAME);
      if(concurrentAlbum?.id){
        await persistProfileAlbumId(profile,concurrentAlbum.id);
        return concurrentAlbum.id;
      }
    }
    throw createError;
  }

  throw Error("Immich created no usable album ID.");
}

async function ensureAlbumMembership(albumId,assetId,profile=searchProfile){
  const result=await api(`/albums/${albumId}/assets`,{
    method:"PUT",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ids:[assetId]})
  },profile);
  if(!Array.isArray(result)||!result.some(x=>
    x.id===assetId&&(x.success===true||x.error==="duplicate")
  )){
    throw Error("Immich did not confirm reference album membership.");
  }
}

function nativeUrl(id,profile=searchProfile){
  if(!profile?.serverUrl)throw Error("No search server is available. Stopped safely.");
  const q={queryAssetId:id};
  return `${profile.serverUrl}/search?query=${encodeURIComponent(JSON.stringify(q))}`;
}

async function openNative(id,profile=searchProfile){
  if(!profile?.id||!profile?.immichUserId){
    throw Error("This profile has no verified Immich identity. Verify it in Settings before opening search.");
  }

  const [apiUser,browserUser]=await Promise.all([
    apiKeyIdentity(profile),
    browserSessionIdentity(profile)
  ]);

  if(apiUser.id!==profile.immichUserId){
    throw Error("The API key identity does not match this profile's verified identity. Re-verify the profile in Settings.");
  }

  if(apiUser.id!==browserUser.id){
    throw Error(
      `Immich account mismatch. Image2Image API key: ${apiUser.name||apiUser.email||apiUser.id}. `+
      `Browser session: ${browserUser.name||browserUser.email||browserUser.id}. `+
      "Sign in to the same Immich account used by the API key, then retry."
    );
  }

  await chrome.tabs.create({url:nativeUrl(id,profile)});
}

async function runSearch(){
  if(!selectedFile)return;

  if(searchInProgress)return;

  const profile=activeProfile?{...activeProfile}:null;
  if(!profile?.id||!profile.serverUrl||!profile.apiKey||!profile.immichUserId){
    setStatus("Select a profile with a verified Immich identity in Settings before searching.");
    return;
  }

  searchProfile=profile;
  searchInProgress=true;
  $("retry-open").hidden=true;setBusy(true);let assetId=null;
  try{
    setStatus("Checking the Image2Image reference album…");
    const albumId=await findOrCreateAlbum(profile);

    setStatus("Uploading archived reference to Immich…");
    const now=new Date().toISOString(),form=new FormData();
    form.append("assetData",selectedFile,selectedFile.name||"clipboard-reference.jpg");
    form.append("fileCreatedAt",now);form.append("fileModifiedAt",now);form.append("visibility","archive");

    const uploaded=await api("/assets",{method:"POST",body:form},profile);
    if(!["created","duplicate"].includes(uploaded?.status)||!uploaded?.id)
      throw Error(`Upload response cannot be used (status: ${uploaded?.status||"unknown"}, asset ID: ${uploaded?.id||"missing"}). Stopped safely.`);
    assetId=uploaded.id;

    setStatus("Ensuring reference album membership…");
    await ensureAlbumMembership(albumId,assetId,profile);

    if(uploaded.status==="duplicate"){
      setStatus("Duplicate detected. Reusing the existing asset for Smart Search…");
    }else{
      setStatus("Waiting for Smart Search indexing…");
    }

    const indexingStarted=Date.now();
    const updateIndexingStatus=()=>{
      const elapsed=Math.floor((Date.now()-indexingStarted)/1000);
      setStatus(`Waiting for Smart Search indexing… ${elapsed}s elapsed`,true);
    };
    updateIndexingStatus();
    const indexingTimer=setInterval(updateIndexingStatus,1000);

    let count=0,lastError=null;
    try{
      for(let i=0;i<30;i++){
        try{
          const result=await api("/search/smart",{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body:JSON.stringify({queryAssetId:assetId,size:10,filter:{id:{ne:assetId}}})
          },profile);
          count=result?.assets?.items?.length||0;
          if(count>0)break;
        }catch(e){lastError=e}
        await new Promise(r=>setTimeout(r,2000));
      }
    }finally{
      clearInterval(indexingTimer);
    }

    if(count){
      setStatus(`Found ${count} similar images. Opening Immich…`);
      await openNative(assetId,profile);
    }else{
      setStatus("Reference is archived in the album, but no results appeared within 60 seconds."+
        (lastError?`\nLast API error: ${lastError.message}`:"\nIndexing may still be pending."));
      $("retry-open").hidden=false;
      $("retry-open").onclick=()=>openNative(assetId,profile);
    }
  }catch(e){
    setStatus(`Stopped: ${e.message}`);
    if(assetId){
      $("retry-open").hidden=false;
      $("retry-open").onclick=()=>openNative(assetId,profile);
    }
  }finally{
    searchInProgress=false;
    setBusy(false);
  }
}

$("search").addEventListener("click",runSearch);

document.addEventListener("keydown",e=>{
  if(e.key!=="Enter"||!selectedFile||$("search").disabled)return;
  if(e.target instanceof HTMLElement&&e.target.closest("button,input,textarea,select,a,[contenteditable=true]"))return;
  e.preventDefault();
  runSearch();
});

async function refreshProfileSelector(){
  const selector=$("profile-select");
  selector.replaceChildren();

  const placeholder=document.createElement("option");
  placeholder.value="";
  placeholder.textContent="Select an account…";
  placeholder.disabled=true;
  placeholder.selected=true;
  selector.append(placeholder);

  for(const profile of profileConfig.profiles){
    const option=document.createElement("option");
    option.value=profile.id;
    option.textContent=profile.name;
    selector.append(option);
  }

  if(!activeProfile){
    selector.value="";
    selector.disabled=profileConfig.profiles.length===0;
    $("profile-status").textContent="No active account selected.";
    $("search").disabled=true;
    if(profileConfig.profiles.length===0){
      setStatus("Add an Immich account in Settings to get started.");
    }else{
      setStatus("Choose an account in Settings before searching.");
    }
    return;
  }

  selector.value=activeProfile.id;
  selector.disabled=searchInProgress;
  $("profile-status").textContent=activeProfile.immichUserId
    ?`Verified identity · ${activeProfile.serverUrl}`
    :"Identity not verified · Open Settings to verify this account.";
  $("search").disabled=!selectedFile||!activeProfile.immichUserId||searchInProgress;

  if(!activeProfile.immichUserId){
    setStatus("Verify the active Immich account in Settings before searching.");
  }else if(!selectedFile){
    setStatus(`Ready · Searching in ${activeProfile.name}. Select an image to continue.`);
  }
}

$("profile-select").addEventListener("change",async()=>{
  if(searchInProgress||!profileConfig)return;

  const nextId=$("profile-select").value;
  const nextProfile=profileConfig.profiles.find(p=>p.id===nextId);
  if(!nextProfile){
    setStatus("Selected account was not found. Stopped safely.");
    await refreshProfileSelector();
    return;
  }

  $("profile-select").disabled=true;
  try{
    profileConfig=await updateConfig(latest=>{
      if(!latest.profiles.some(p=>p.id===nextId))
        throw Error("The selected account was removed in another window.");

      latest.activeProfileId=nextId;
    });

    const updatedProfile=profileConfig.profiles.find(p=>p.id===nextId);
    activeProfile={...updatedProfile};

    await refreshProfileSelector();
    setStatus(activeProfile.immichUserId
      ?`Ready to search in ${activeProfile.name}.`
      :"Verify this account in Settings before searching.");
  }catch(e){
    try{
      profileConfig=await loadConfig();
      activeProfile=profileConfig.profiles.find(
        p=>p.id===profileConfig.activeProfileId
      )||null;
      await refreshProfileSelector();
    }catch(refreshError){
      setStatus(`Could not refresh account settings: ${refreshError.message}`);
      return;
    }

    setStatus(`Could not save account selection: ${e.message}`);
  }
});

(async()=>{
  try{
    profileConfig=await loadConfig();
    activeProfile=profileConfig.profiles.find(
      p=>p.id===profileConfig.activeProfileId
    )||null;
    await refreshProfileSelector();
  }catch(e){
    $("profile-select").disabled=true;
    $("search").disabled=true;
    $("profile-status").textContent="Could not load account configuration.";
    setStatus(`Stopped: ${e.message}`);
  }
})();
