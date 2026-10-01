const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
require("dotenv").config();

const app = express();
const authRoutes = require("./routes/auth");
const { createRealtimeStore } = require("./socketManager");

const neighborlyEntryFile = path.join(__dirname, "../FRONTEND/www/Neighborly(Update).html");
const realtimeStore = createRealtimeStore();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);

// The Electron shell requests /login.html; map it to the checked-in login page.
app.get("/login.html", (req, res) => {
  res.sendFile(path.join(__dirname, "../FRONTEND/www/login [updated].html"));
});

app.get("/Neighborly.html", (req, res) => {
  res.sendFile(neighborlyEntryFile);
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../FRONTEND/www/login [updated].html"));
});

app.get("/api", (req, res) => {
  res.json({
    app: "Neighborly Backend",
    version: "1.0",
    status: "Running",
    realtime: "socket.io active",
    users: realtimeStore.getOnlineUsers(),
  });
});

app.get("/api/users", (req, res) => {
  res.json({ users: realtimeStore.getOnlineUsers() });
});

// Serve static files from FRONTEND/www directory
app.use(express.static(path.join(__dirname, "../FRONTEND/www")));

// Fallback: Serve the actual Neighborly app entry file for all other routes (SPA support)
app.get("*", (req, res) => {
  res.sendFile(neighborlyEntryFile);
});

io.on("connection", (socket) => {
  socket.emit("welcome", { message: "Connected to Neighborly realtime" });

  socket.on("register-user", (payload = {}) => {
    const user = payload.user || {};
    const normalizedUser = {
      id: user.id || `guest-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: user.name || user.email?.split("@")[0] || "Guest",
      email: user.email || "",
      handle: user.handle || user.email?.split("@")[0] || "guest",
    };

    socket.user = realtimeStore.registerUser(normalizedUser);
    socket.emit("online-users", realtimeStore.getOnlineUsers());
    io.emit("presence-update", { users: realtimeStore.getOnlineUsers() });
  });

  socket.on("join-channel", (payload = {}) => {
    const channel = payload.channel || "server-coffe_channel-update";
    socket.join(channel);
    socket.emit("joined-channel", { channel });
  });

  socket.on("chat:send", (payload = {}) => {
    const channel = payload.channel || "server-coffe_channel-update";
    const message = realtimeStore.addMessage({
      channel,
      author: payload.author || "Neighborly User",
      text: payload.text || "",
      attachment: payload.attachment || null,
      clientMessageId: payload.clientMessageId || null,
    });

    io.to(channel).emit("chat:message", {
      ...message,
      serverId: payload.serverId || "server-coffe",
      channelId: channel.replace(/^.*?_/, "") || payload.channelId || "channel-update",
    });
  });

  socket.on("chat:edit", (payload = {}) => {
    const channel = payload.channel || "server-coffe_channel-update";
    io.to(channel).emit("chat:edit", {
      channel,
      messageId: payload.messageId,
      text: payload.text || "",
    });
  });

  socket.on("chat:delete", (payload = {}) => {
    const channel = payload.channel || "server-coffe_channel-update";
    io.to(channel).emit("chat:delete", {
      channel,
      messageId: payload.messageId,
    });
  });

  socket.on("chat:reaction", (payload = {}) => {
    const channel = payload.channel || "server-coffe_channel-update";
    io.to(channel).emit("chat:reaction", {
      channel,
      messageId: payload.messageId,
      emoji: payload.emoji,
    });
  });

  socket.on("chat:typing", (payload = {}) => {
    const channel = payload.channel || "server-coffe_channel-update";
    io.to(channel).emit("chat:typing", {
      channel,
      user: payload.user,
    });
  });

  socket.on("request-online-users", () => {
    socket.emit("online-users", realtimeStore.getOnlineUsers());
  });

  socket.on("voice:join", async (payload = {}) => {
    const channelId = String(payload.channel || "").trim().slice(0, 180);
    if (!channelId) return;

    if (socket.data.voiceRoom) {
      const previousRoom = socket.data.voiceRoom;
      socket.to(previousRoom).emit("voice:peer-left", { peerId: socket.id });
      socket.leave(previousRoom);
    }

    const room = `voice:${channelId}`;
    const existingSockets = await io.in(room).fetchSockets();
    const peers = existingSockets.map((peerSocket) => ({
      id: peerSocket.id,
      ...(peerSocket.data.voiceProfile || {}),
      state: peerSocket.data.voiceState || {},
    }));
    const user = payload.user || {};
    const voiceProfile = {
      name: String(user.name || "Neighborly User").slice(0, 60),
      handle: String(user.handle || "").slice(0, 60),
      initials: String(user.initials || "").slice(0, 4),
      color: /^#[\da-f]{6}$/i.test(user.color || "") ? user.color : "#7c6ff7",
      avatarImage: typeof user.avatarImage === "string" && user.avatarImage.length < 100000 ? user.avatarImage : null,
    };
    const voiceState = {
      micMuted: payload.state?.micMuted !== false,
      deafened: payload.state?.deafened === true,
      cameraEnabled: payload.state?.cameraEnabled === true,
      screenSharing: payload.state?.screenSharing === true,
    };

    socket.data.voiceRoom = room;
    socket.data.voiceChannelId = channelId;
    socket.data.voiceProfile = voiceProfile;
    socket.data.voiceState = voiceState;
    socket.join(room);
    socket.emit("voice:peers", { channel: channelId, peers });
    socket.to(room).emit("voice:peer-joined", { channel: channelId, peer: { id: socket.id, ...voiceProfile, state: voiceState } });
  });

  socket.on("voice:state", (payload = {}) => {
    const room = socket.data.voiceRoom;
    if (!room || (payload.channel && String(payload.channel) !== socket.data.voiceChannelId)) return;
    const state = {
      micMuted: payload.state?.micMuted === true,
      deafened: payload.state?.deafened === true,
      cameraEnabled: payload.state?.cameraEnabled === true,
      screenSharing: payload.state?.screenSharing === true,
    };
    socket.data.voiceState = state;
    socket.to(room).emit("voice:peer-state", { peerId: socket.id, state });
  });

  socket.on("voice:leave", (payload = {}) => {
    const room = socket.data.voiceRoom;
    if (!room || (payload.channel && String(payload.channel) !== socket.data.voiceChannelId)) return;
    socket.to(room).emit("voice:peer-left", { peerId: socket.id });
    socket.leave(room);
    socket.data.voiceRoom = null;
    socket.data.voiceChannelId = null;
    socket.data.voiceProfile = null;
    socket.data.voiceState = null;
  });

  socket.on("webrtc:offer", (payload) => {
    const target = payload?.to ? io.sockets.sockets.get(payload.to) : null;
    if (target && socket.data.voiceRoom && target.data.voiceRoom === socket.data.voiceRoom) {
      io.to(payload.to).emit("webrtc:offer", { ...payload, from: socket.id });
    }
  });

  socket.on("webrtc:answer", (payload) => {
    const target = payload?.to ? io.sockets.sockets.get(payload.to) : null;
    if (target && socket.data.voiceRoom && target.data.voiceRoom === socket.data.voiceRoom) {
      io.to(payload.to).emit("webrtc:answer", { ...payload, from: socket.id });
    }
  });

  socket.on("webrtc:ice-candidate", (payload) => {
    const target = payload?.to ? io.sockets.sockets.get(payload.to) : null;
    if (target && socket.data.voiceRoom && target.data.voiceRoom === socket.data.voiceRoom) {
      io.to(payload.to).emit("webrtc:ice-candidate", { ...payload, from: socket.id });
    }
  });

  socket.on("disconnect", () => {
    if (socket.data.voiceRoom) {
      socket.to(socket.data.voiceRoom).emit("voice:peer-left", { peerId: socket.id });
    }
    if (socket.user && socket.user.id) {
      realtimeStore.removeUser(socket.user.id);
    }
    io.emit("presence-update", { users: realtimeStore.getOnlineUsers() });
  });
});

const preferredPort = Number(process.env.PORT) || 3001;

function listenOnPort(port) {
  server.listen(port, "0.0.0.0", () => {
    console.log(`Neighborly backend listening on http://localhost:${port}`);
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && !process.env.PORT) {
    const fallbackPort = preferredPort + 1;
    listenOnPort(fallbackPort);
    return;
  }

  throw error;
});

listenOnPort(preferredPort);