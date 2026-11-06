import java.net.*;
import java.util.concurrent.*;

/** Opaque local UDP transport; no speech decoding, keys or packet recording. */
public final class DatagramRelay {
    private static final ConcurrentHashMap<SocketAddress,Peer> peers=new ConcurrentHashMap<>();
    private static DatagramSocket listener;
    private static String upstream;
    private static final class Peer {
        final DatagramSocket socket;
        volatile long used=System.nanoTime();
        Peer(SocketAddress client)throws Exception{
            socket=new DatagramSocket();socket.connect(InetAddress.getByName(upstream),24454);socket.setSoTimeout(5000);
            Thread.startVirtualThread(()->{try{while(System.nanoTime()-used<TimeUnit.SECONDS.toNanos(120)){
                DatagramPacket packet=new DatagramPacket(new byte[4096],4096);
                try{socket.receive(packet);listener.send(new DatagramPacket(packet.getData(),packet.getLength(),client));}catch(SocketTimeoutException idle){}
            }}catch(Exception ignored){}finally{peers.remove(client,this);socket.close();}});
        }
    }
    public static void main(String[] args)throws Exception{
        if(args.length!=1||!args[0].equals("agentcity-minecraft"))throw new IllegalArgumentException("Owned Minecraft upstream required");
        upstream=args[0];listener=new DatagramSocket(24454);
        while(true){DatagramPacket packet=new DatagramPacket(new byte[4097],4097);listener.receive(packet);if(packet.getLength()>4096)continue;
            SocketAddress client=packet.getSocketAddress();Peer peer=peers.get(client);
            if(peer==null){if(peers.size()>=32)continue;try{peer=new Peer(client);peers.put(client,peer);}catch(Exception unavailable){continue;}}
            peer.used=System.nanoTime();try{peer.socket.send(new DatagramPacket(packet.getData(),packet.getLength()));}catch(Exception unavailable){peers.remove(client,peer);peer.socket.close();}
        }
    }
}
