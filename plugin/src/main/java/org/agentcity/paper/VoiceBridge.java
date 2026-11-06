package org.agentcity.paper;

import de.maxhenkel.voicechat.api.*;
import de.maxhenkel.voicechat.api.audiochannel.AudioPlayer;
import de.maxhenkel.voicechat.api.events.*;
import de.maxhenkel.voicechat.api.opus.OpusDecoder;
import de.maxhenkel.voicechat.api.opus.OpusEncoder;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.java.JavaPlugin;

/** Private push-to-talk for the current approved Minecraft connection. Audio stays in memory. */
final class VoiceBridge implements VoicechatPlugin, Listener, AutoCloseable {
    private final JavaPlugin plugin;
    private final PlayableExperience experience;
    private volatile VoicechatServerApi voice;
    private final Map<UUID,Enrollment> enrolled=new ConcurrentHashMap<>();
    private final Map<UUID,Capture> captures=new ConcurrentHashMap<>();
    private final Map<UUID,Clip> clips=new ConcurrentHashMap<>();
    private final Map<UUID,AudioPlayer> playing=new ConcurrentHashMap<>();
    private final Set<String> replies=new LinkedHashSet<>();
    private boolean closed;
    private static final int MAX_PCM=384000;
    private static final class Enrollment {
        final UUID player; final String connection,principal,provider; volatile UUID turn;
        Enrollment(UUID player,String connection,String principal,String provider){this.player=player;this.connection=connection;this.principal=principal;this.provider=provider;}
    }
    private static final class Capture {
        final UUID id=UUID.randomUUID(); final Enrollment owner; final long created=System.currentTimeMillis();
        final OpusDecoder decoder; final ByteArrayOutputStream pcm=new ByteArrayOutputStream();
        volatile long last=System.currentTimeMillis(); boolean finished;
        Capture(Enrollment owner,OpusDecoder decoder){this.owner=owner;this.decoder=decoder;}
    }
    private record Clip(Capture capture,byte[] pcm) {}
    VoiceBridge(JavaPlugin plugin,PlayableExperience experience){
        this.plugin=plugin;this.experience=experience;
        Bukkit.getPluginManager().registerEvents(this,plugin);
        var registration=Bukkit.getServicesManager().getRegistration(BukkitVoicechatService.class);
        if(registration==null)throw new IllegalStateException("voicechat_service_required");
        registration.getProvider().registerPlugin(this);
        Bukkit.getScheduler().runTaskTimer(plugin,()->{
            long now=System.currentTimeMillis();
            for(var entry:captures.entrySet())if(now-entry.getValue().last>650&&captures.remove(entry.getKey(),entry.getValue()))finish(entry.getValue());
            clips.entrySet().removeIf(e->now-e.getValue().capture.created>120000);
        },5L,5L);
    }
    @Override public String getPluginId(){return "ethcraft_voice";}
    @Override public void initialize(VoicechatApi api){if(api instanceof VoicechatServerApi server)voice=server;}
    @Override public void registerEvents(EventRegistration events){
        events.registerEvent(VoicechatServerStartedEvent.class,event->voice=event.getVoicechat());
        events.registerEvent(MicrophonePacketEvent.class,this::microphone,100);
    }
    private boolean valid(Enrollment owner){
        Map<String,Object> session=experience.connection(owner.player);
        return Boolean.TRUE.equals(session.get("online"))&&Boolean.FALSE.equals(session.get("pendingAuthentication"))&&owner.connection.equals(session.get("connectionId"))&&owner.principal.equals(session.get("principalId"));
    }
    @EventHandler(priority=EventPriority.LOWEST) public void command(PlayerCommandPreprocessEvent event){
        String[] words=event.getMessage().trim().split("\\s+");if(!words[0].equalsIgnoreCase("/voice"))return;
        event.setCancelled(true);Player player=event.getPlayer();String selected=words.length==2?words[1].toLowerCase(Locale.ROOT):"status";
        if(selected.equals("off")){remove(player.getUniqueId());player.sendMessage("Voice control off. Your existing work remains saved.");return;}
        if(selected.equals("status")){player.sendMessage("Voice: "+(enrolled.containsKey(player.getUniqueId())?enrolled.get(player.getUniqueId()).provider:"off")+". Use /voice 0g, /voice agent or /voice off. Hold your voice-chat push-to-talk key to speak.");return;}
        if(!Set.of("0g","agent").contains(selected)){player.sendMessage("Use /voice 0g, /voice agent, /voice off or /voice status.");return;}
        Map<String,Object> session=experience.connection(player.getUniqueId());
        if(!Boolean.FALSE.equals(session.get("pendingAuthentication"))||!(session.get("principalId") instanceof String principal)||principal.isBlank()){player.sendMessage("Approve this Minecraft connection with Discord /join first.");return;}
        VoicechatConnection connection=voice==null?null:voice.getConnectionOf(player.getUniqueId());
        if(connection==null||!connection.isInstalled()||!connection.isConnected()){player.sendMessage("Install the EthCraft Fabric voice profile and connect voice chat first. Press V for microphone settings.");return;}
        remove(player.getUniqueId());enrolled.put(player.getUniqueId(),new Enrollment(player.getUniqueId(),(String)session.get("connectionId"),principal,selected));
        player.sendMessage("Private AI voice enabled for "+selected+". Hold push-to-talk to speak, release to send. Maximum 12 seconds. Press V to check your microphone. /voice off disables it.");
    }
    private void microphone(MicrophonePacketEvent event){
        // This local server uses microphone packets for private AI control, never public broadcast.
        event.cancel();if(closed||voice==null||event.getSenderConnection()==null)return;
        UUID player=event.getSenderConnection().getPlayer().getUuid();Enrollment owner=enrolled.get(player);if(owner==null)return;
        byte[] opus=event.getPacket().getOpusEncodedData();
        if(opus==null||opus.length==0){Capture capture=captures.remove(player);if(capture!=null)finish(capture);return;}
        if(opus.length>4096)return;
        Capture capture=captures.computeIfAbsent(player,id->{Capture c=new Capture(owner,voice.createDecoder());owner.turn=c.id;clips.entrySet().removeIf(e->e.getValue().capture.owner.player.equals(id));Bukkit.getScheduler().runTask(plugin,()->stopAudio(id));return c;});
        synchronized(capture){
            capture.last=System.currentTimeMillis();if(capture.finished)return;
            try{
                short[] decoded=capture.decoder.decode(opus);
                for(int i=0;i<decoded.length&&capture.pcm.size()<MAX_PCM;i+=3){capture.pcm.write(decoded[i]&255);capture.pcm.write((decoded[i]>>8)&255);}
                if(capture.pcm.size()>=MAX_PCM)finish(capture);
            }catch(RuntimeException error){capture.finished=true;capture.decoder.close();}
        }
    }
    private void finish(Capture capture){
        byte[] pcm;
        synchronized(capture){if(capture.finished)return;capture.finished=true;capture.decoder.close();pcm=capture.pcm.toByteArray();}
        Bukkit.getScheduler().runTask(plugin,()->{
            if(closed||enrolled.get(capture.owner.player)!=capture.owner||!capture.id.equals(capture.owner.turn)||!valid(capture.owner))return;
            Player player=Bukkit.getPlayer(capture.owner.player);
            if(pcm.length<6400){if(player!=null)player.sendMessage("Voice clip too short. Hold push-to-talk while saying your command.");return;}
            clips.put(capture.id,new Clip(capture,pcm));if(player!=null)player.sendMessage("[Voice] Listening to your command...");
        });
    }
    private Map<String,Object> metadata(Capture capture){return Map.of("operationId",capture.id.toString(),"playerId",capture.owner.player.toString(),"connectionId",capture.owner.connection,"provider",capture.owner.provider,"createdAtMs",capture.created);}
    Map<String,Object> status(){
        List<Map<String,Object>> owners=new ArrayList<>();
        for(Enrollment e:enrolled.values())if(valid(e))owners.add(Map.of("playerId",e.player.toString(),"connectionId",e.connection,"provider",e.provider,"turnId",e.turn==null?"":e.turn.toString()));
        return Map.of("available",!closed,"initialized",voice!=null,"enrolled",owners,"pending",clips.values().stream().map(c->metadata(c.capture)).toList());
    }
    Map<String,Object> clip(UUID id){
        Clip clip=clips.get(id);if(clip==null||!valid(clip.capture.owner))throw new IllegalArgumentException("voice_clip_not_available");
        ByteBuffer wav=ByteBuffer.allocate(44+clip.pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        wav.put("RIFF".getBytes()).putInt(36+clip.pcm.length).put("WAVEfmt ".getBytes()).putInt(16).putShort((short)1).putShort((short)1).putInt(16000).putInt(32000).putShort((short)2).putShort((short)16).put("data".getBytes()).putInt(clip.pcm.length).put(clip.pcm);
        Map<String,Object> result=new LinkedHashMap<>(metadata(clip.capture));result.put("wavBase64",Base64.getEncoder().encodeToString(wav.array()));return result;
    }
    Map<String,Object> ack(UUID id){clips.remove(id);return Map.of("ok",true);}
    Map<String,Object> reply(Map<String,Object> input){
        UUID id=UUID.fromString((String)input.get("operationId")),playerId=UUID.fromString((String)input.get("playerId"));Enrollment owner=enrolled.get(playerId);
        if(owner==null||!id.equals(owner.turn)||!owner.connection.equals(input.get("connectionId"))||!owner.provider.equals(input.get("provider"))||!valid(owner))return Map.of("played",false,"reason","stale_connection_or_turn");
        String text=(String)input.get("text");if(text==null||text.length()>400)throw new IllegalArgumentException("voice_reply_text");
        String receipt=id+":"+Objects.toString(input.get("noticeId"),"reply");if(replies.contains(receipt))return Map.of("played",false,"duplicate",true);
        byte[] pcm=input.get("pcmBase64") instanceof String encoded?Base64.getDecoder().decode(encoded):new byte[0];
        if(pcm.length>2880000||pcm.length%2!=0)throw new IllegalArgumentException("voice_reply_audio");
        Player player=Bukkit.getPlayer(playerId);player.sendMessage("[Voice] "+text);
        if(pcm.length>0){
            VoicechatConnection connection=voice.getConnectionOf(playerId);if(connection==null||!connection.isConnected())return Map.of("played",false,"reason","voice_disconnected");
            short[] samples=new short[pcm.length/2];ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples);
            stopAudio(playerId);var channel=voice.createStaticAudioChannel(UUID.randomUUID());channel.addTarget(connection);
            OpusEncoder encoder=voice.createEncoder();AudioPlayer audio=voice.createAudioPlayer(channel,encoder,samples);
            if(audio==null){encoder.close();throw new IllegalStateException("voice_audio_player_unavailable");}
            playing.put(playerId,audio);audio.setOnStopped(()->{playing.remove(playerId,audio);encoder.close();});audio.startPlaying();
        }
        replies.add(receipt);while(replies.size()>4096)replies.remove(replies.iterator().next());return Map.of("played",pcm.length>0);
    }
    private void stopAudio(UUID player){AudioPlayer audio=playing.remove(player);if(audio!=null)audio.stopPlaying();}
    private void remove(UUID player){Enrollment e=enrolled.remove(player);Capture c=captures.remove(player);if(c!=null)synchronized(c){if(!c.finished){c.finished=true;c.decoder.close();}}clips.entrySet().removeIf(x->x.getValue().capture.owner.player.equals(player));stopAudio(player);}
    @EventHandler public void quit(PlayerQuitEvent event){remove(event.getPlayer().getUniqueId());}
    @Override public void close(){closed=true;for(UUID player:new ArrayList<>(enrolled.keySet()))remove(player);}
}
