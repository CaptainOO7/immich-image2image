"use strict";

const profileList = document.getElementById("profile-list");
const nameInput = document.getElementById("profile-name");
const serverInput = document.getElementById("server");
const keyInput = document.getElementById("api-key");
const keyHint = document.getElementById("api-key-hint");
const identityStatus = document.getElementById("identity-status");
const status = document.getElementById("status");

let config;
let selectedProfileId = null;
let creatingProfile = false;

function normalizeServer(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid Immich server URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("The server URL must start with http:// or https://.");
  }

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  ) {
    throw new Error("Enter only the Immich server origin, without a path, credentials, query string, or fragment.");
  }

  return url.origin;
}

function originPattern(serverUrl) {
  return `${new URL(serverUrl).origin}/*`;
}

function selectedProfile() {
  return config.profiles.find(profile => profile.id === selectedProfileId) || null;
}

function setStatus(message) {
  status.textContent = message;
}

function renderProfiles() {
  profileList.replaceChildren();

  if (!config.profiles.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No profiles yet. Add an Immich account to get started.";
    profileList.append(empty);
    return;
  }

  for (const profile of config.profiles) {
    const item = document.createElement("div");
    item.className = "profile-item";
    if (profile.id === selectedProfileId) item.classList.add("selected");

    const details = document.createElement("div");
    details.className = "profile-details";

    const name = document.createElement("div");
    name.className = "profile-name";
    name.textContent = profile.name;

    const server = document.createElement("div");
    server.className = "profile-server";
    server.textContent = profile.serverUrl || "Server URL not configured";

    const badges = document.createElement("div");
    badges.className = "profile-badges";

    if (profile.id === config.activeProfileId) {
      const badge = document.createElement("span");
      badge.className = "profile-badge active";
      badge.textContent = "Active";
      badges.append(badge);
    }

    const verification = document.createElement("span");
    verification.className = "profile-badge";
    if (profile.immichUserId) {
      verification.classList.add("verified");
      verification.textContent = "API identity verified";
    } else {
      verification.textContent = "Not verified";
    }
    badges.append(verification);

    details.append(name, server, badges);

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "secondary";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => selectProfile(profile.id));

    item.append(details, edit);
    profileList.append(item);
  }
}

function updateEditor() {
  const profile = selectedProfile();

  if (creatingProfile || !profile) {
    nameInput.value = "";
    serverInput.value = "";
    keyInput.value = "";
    keyInput.placeholder = "Enter an API key";
    keyHint.textContent = "A new profile requires an API key.";
    identityStatus.textContent = "Identity not verified.";
    document.getElementById("set-active").disabled = true;
    document.getElementById("remove-profile").disabled = true;
    return;
  }

  nameInput.value = profile.name;
  serverInput.value = profile.serverUrl;
  keyInput.value = "";
  keyInput.placeholder = profile.apiKey
    ? "Saved API key — leave blank to keep it"
    : "Enter an API key";
  keyHint.textContent = profile.apiKey
    ? "A key is saved. Leave this blank to keep it, or enter a replacement."
    : "No API key is saved. Enter one before using this profile.";

  identityStatus.textContent = profile.immichUserId
    ? `API identity verified. User ID: ${profile.immichUserId}`
    : "Identity not verified. Save the profile to verify its API key.";

  document.getElementById("set-active").disabled =
    profile.id === config.activeProfileId;
  document.getElementById("remove-profile").disabled = false;
}

function selectProfile(id) {
  selectedProfileId = id;
  creatingProfile = false;
  setStatus("");
  renderProfiles();
  updateEditor();
}

function beginNewProfile() {
  selectedProfileId = null;
  creatingProfile = true;
  setStatus("");
  renderProfiles();
  updateEditor();
  nameInput.focus();
}

async function verifyApiIdentity(profile) {
  const response = await fetch(`${profile.serverUrl}/api/users/me`, {
    method: "GET",
    headers: {
      "x-api-key": profile.apiKey,
      "Accept": "application/json"
    },
    credentials: "omit",
    cache: "no-store",
    redirect: "error"
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? `API identity verification failed (HTTP ${response.status}). Check the API key and ensure it has user.read permission.`
        : `API identity verification failed (HTTP ${response.status}).`
    );
  }

  const identity = await response.json();

  if (!identity || typeof identity.id !== "string" || !identity.id) {
    throw new Error("The server response did not contain a valid Immich user ID.");
  }

  return identity.id;
}

async function saveProfile() {
  setStatus("");

  const name = nameInput.value.trim();
  if (!name) throw new Error("Enter a profile name.");

  const serverUrl = normalizeServer(serverInput.value);
  const previous = selectedProfile();
  const enteredKey = keyInput.value.trim();
  const apiKey = enteredKey || previous?.apiKey || "";

  if (!apiKey) throw new Error("Enter an Immich API key for this profile.");

  const serverChanged = Boolean(previous && previous.serverUrl !== serverUrl);
  const keyChanged = Boolean(previous && enteredKey && enteredKey !== previous.apiKey);

  const granted = await chrome.permissions.request({
    origins: [originPattern(serverUrl)]
  });

  if (!granted) {
    throw new Error("Server permission was not granted. The profile was not saved.");
  }

  const profile = previous
    ? { ...previous }
    : {
        id: crypto.randomUUID(),
        name,
        serverUrl,
        apiKey,
        immichUserId: null,
        albumId: ""
      };

  profile.name = name;
  profile.serverUrl = serverUrl;
  profile.apiKey = apiKey;

  if (serverChanged || keyChanged) {
    profile.immichUserId = null;
  }

  if (serverChanged) {
    profile.albumId = "";
  }

  config = await updateConfig(latest => {
    if (previous) {
      const current = latest.profiles.find(item => item.id === previous.id);

      if (!current) {
        throw new Error("This profile was removed in another window. Reload Settings before continuing.");
      }

      if (
        current.serverUrl !== previous.serverUrl ||
        current.apiKey !== previous.apiKey
      ) {
        throw new Error("This profile's server or API key changed in another window. Reload Settings before editing it.");
      }

      current.name = name;
      current.serverUrl = serverUrl;
      current.apiKey = apiKey;

      if (serverChanged || keyChanged) {
        current.immichUserId = null;
      }

      if (serverChanged) {
        current.albumId = "";
      }
    } else {
      if (latest.profiles.some(item => item.id === profile.id)) {
        throw new Error("This new profile ID already exists. Try again.");
      }

      latest.profiles.push({ ...profile });

      if (latest.activeProfileId === null) {
        latest.activeProfileId = profile.id;
      }
    }
  });

  const savedProfile = config.profiles.find(item => item.id === profile.id);
  if (!savedProfile) {
    throw new Error("The saved profile could not be found.");
  }

  const verificationProfile = { ...savedProfile };

  selectedProfileId = profile.id;
  creatingProfile = false;

  keyInput.value = "";
  renderProfiles();
  updateEditor();

  setStatus("Profile saved. Verifying its API identity…");

  try {
    const userId = await verifyApiIdentity(verificationProfile);

    config = await updateConfig(latest => {
      const current = latest.profiles.find(item => item.id === profile.id);

      if (!current) {
        throw new Error("The profile was removed before verification completed.");
      }

      if (
        current.serverUrl !== verificationProfile.serverUrl ||
        current.apiKey !== verificationProfile.apiKey
      ) {
        throw new Error("The profile's server or API key changed during verification. The outdated result was not saved.");
      }

      current.immichUserId = userId;
    });

    renderProfiles();
    updateEditor();
    setStatus("Profile saved and API identity verified.");
  } catch (error) {
    config = await loadConfig();
    renderProfiles();
    updateEditor();
    setStatus(`Profile saved, but identity verification failed: ${error.message}`);
  }

  if (serverChanged && previous.serverUrl) {
    await revokeUnusedOrigin(previous.serverUrl);
  }
}

async function revokeUnusedOrigin(serverUrl) {
  let oldPattern;

  try {
    oldPattern = originPattern(serverUrl);
  } catch {
    setStatus("Could not determine the previous server permission.");
    return;
  }

  let wasGranted;

  try {
    wasGranted = await chrome.permissions.contains({
      origins: [oldPattern]
    });
  } catch (error) {
    setStatus(
      `Could not inspect previous server permission: ${error.message}`
    );
    return;
  }

  const stillUsed = config.profiles.some(profile => {
    if (!profile.serverUrl) return false;

    try {
      return originPattern(profile.serverUrl) === oldPattern;
    } catch {
      return false;
    }
  });

  if (stillUsed) {
    setStatus(
      wasGranted
        ? "Previous server permission retained because another profile uses this origin."
        : "Another profile uses this origin, but its permission is not currently granted."
    );
    return;
  }

  if (!wasGranted) {
    setStatus("Previous server permission was already absent.");
    return;
  }

  let removalResult;

  try {
    removalResult = await chrome.permissions.remove({
      origins: [oldPattern]
    });
  } catch (error) {
    setStatus(
      `Chrome could not revoke the unused server permission: ${error.message}`
    );
    return;
  }

  let isStillGranted;

  try {
    isStillGranted = await chrome.permissions.contains({
      origins: [oldPattern]
    });
  } catch (error) {
    setStatus(
      `Permission removal returned ${removalResult}, but final verification failed: ${error.message}`
    );
    return;
  }

  if (!isStillGranted) {
    setStatus("Unused server permission successfully revoked and verified.");
  } else if (!removalResult) {
    setStatus("Chrome reported that permission removal failed; permission remains granted.");
  } else {
    setStatus("Chrome reported successful removal, but permission remains granted.");
  }
}
async function setActiveProfile() {
  const profile = selectedProfile();
  if (!profile) throw new Error("Select a profile first.");

  config = await updateConfig(latest => {
    if (!latest.profiles.some(item => item.id === profile.id)) {
      throw new Error("This profile was removed in another window. Reload Settings before continuing.");
    }

    latest.activeProfileId = profile.id;
  });

  const updatedProfile = config.profiles.find(item => item.id === profile.id);

  renderProfiles();
  updateEditor();
  setStatus(`${updatedProfile.name} is now the active profile.`);
}

async function removeSelectedProfile() {
  const profile = selectedProfile();
  if (!profile) throw new Error("Select a profile first.");

  if (!confirm(
    `Remove the local profile "${profile.name}"?\n\nThis removes only its extension settings. It does not delete anything from Immich.`
  )) {
    return;
  }

  let removedProfile = null;

  config = await updateConfig(latest => {
    const index = latest.profiles.findIndex(item => item.id === profile.id);

    if (index === -1) {
      throw new Error("This profile was already removed in another window. Reload Settings before continuing.");
    }

    removedProfile = { ...latest.profiles[index] };
    latest.profiles.splice(index, 1);

    if (latest.activeProfileId === profile.id) {
      latest.activeProfileId = latest.profiles.length
        ? latest.profiles[0].id
        : null;
    }
  });

  selectedProfileId = config.activeProfileId;
  creatingProfile = !selectedProfileId;

  renderProfiles();
  updateEditor();
  setStatus("Local profile removed. Immich albums and assets were not changed.");

  if (removedProfile.serverUrl) {
    await revokeUnusedOrigin(removedProfile.serverUrl);
  }
}

document.getElementById("add-profile").addEventListener("click", beginNewProfile);

document.getElementById("save-profile").addEventListener("click", async () => {
  try {
    await saveProfile();
  } catch (error) {
    setStatus(error.message);
  }
});

document.getElementById("set-active").addEventListener("click", async () => {
  try {
    await setActiveProfile();
  } catch (error) {
    setStatus(error.message);
  }
});

document.getElementById("remove-profile").addEventListener("click", async () => {
  try {
    await removeSelectedProfile();
  } catch (error) {
    setStatus(error.message);
  }
});

(async () => {
  try {
    config = await loadConfig();
    selectedProfileId = config.activeProfileId;
    creatingProfile = !selectedProfileId;

    renderProfiles();
    updateEditor();

    if (config.profiles.length) {
      setStatus("Profiles loaded.");
    } else {
      setStatus("Add an Immich profile to get started.");
    }
  } catch (error) {
    setStatus(`Could not load profile settings: ${error.message}`);
    document.getElementById("save-profile").disabled = true;
    document.getElementById("add-profile").disabled = true;
  }
})();
