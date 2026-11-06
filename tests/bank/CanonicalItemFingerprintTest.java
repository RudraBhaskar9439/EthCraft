package org.agentcity.paper;

import java.io.*;
import java.util.*;
import java.util.zip.GZIPOutputStream;

public final class CanonicalItemFingerprintTest {
    interface Writer { void write(DataOutputStream output) throws IOException; }
    static byte[] item(Writer contents) throws IOException {
        var nbt = new ByteArrayOutputStream();
        var output = new DataOutputStream(nbt);
        output.writeByte(10); output.writeUTF(""); contents.write(output); output.writeByte(0);
        var compressed = new ByteArrayOutputStream();
        try (var gzip = new GZIPOutputStream(compressed)) { gzip.write(nbt.toByteArray()); }
        var encoded = new ByteArrayOutputStream();
        output = new DataOutputStream(encoded);output.writeByte(1);output.writeInt(1);output.writeInt(compressed.size());compressed.writeTo(output);
        return encoded.toByteArray();
    }
    static void field(DataOutputStream output, int type, String name, Writer value) throws IOException {
        output.writeByte(type);output.writeUTF(name);value.write(output);
    }
    static void check(boolean value, String name) { if (!value) throw new AssertionError(name); }
    static void value(DataOutputStream out,int type,int seed)throws IOException {
        switch(type){
            case 1->out.writeByte(seed);case 2->out.writeShort(seed);case 3->out.writeInt(seed);case 4->out.writeLong(seed);
            case 5->out.writeInt(0x7fc00000+seed);case 6->out.writeLong(0x7ff8000000000000L+seed);
            case 7->{out.writeInt(2);out.writeByte(seed);out.writeByte(seed+1);}
            case 8->out.writeUTF("proof\0"+seed);
            case 9->{out.writeByte(3);out.writeInt(1);out.writeInt(seed);}
            case 10->{field(out,8,"inside",v->v.writeUTF("value"+seed));out.writeByte(0);}
            case 11->{out.writeInt(1);out.writeInt(seed);}case 12->{out.writeInt(1);out.writeLong(seed);}
            default->throw new IOException("test type");
        }
    }
    static void nested(DataOutputStream out,int depth)throws IOException {
        if(depth>0)field(out,10,"nested",v->nested(v,depth-1));out.writeByte(0);
    }
    static void refused(byte[] input,String label){boolean refused=false;try{CanonicalItemFingerprint.hash(input);}catch(IllegalArgumentException expected){refused=true;}check(refused,label);}
    public static void main(String[] args) throws Exception {
        if(args.length==2&&args[0].equals("--hash")){System.out.println(CanonicalItemFingerprint.hash(java.nio.file.Files.readAllBytes(java.nio.file.Path.of(args[1]))));return;}
        byte[] a = item(out -> { field(out, 3, "damage", v -> v.writeInt(7));field(out, 10, "pdc", v -> {field(v, 8, "owner", t -> t.writeUTF("borrower"));field(v, 1, "proof", t -> t.writeByte(1));v.writeByte(0);}); });
        byte[] b = item(out -> { field(out, 10, "pdc", v -> {field(v, 1, "proof", t -> t.writeByte(1));field(v, 8, "owner", t -> t.writeUTF("borrower"));v.writeByte(0);});field(out, 3, "damage", v -> v.writeInt(7)); });
        check(!Arrays.equals(a,b), "fixture compound order differs");
        check(CanonicalItemFingerprint.hash(a).equals(CanonicalItemFingerprint.hash(b)), "compound order stable including PDC");
        check(!CanonicalItemFingerprint.hash(a).equals(CanonicalItemFingerprint.hash(item(out -> field(out, 3, "damage", v -> v.writeInt(8))))), "damage is preserved");
        byte[] byteValue=item(out -> field(out,1,"value",v->v.writeByte(1))),intValue=item(out -> field(out,3,"value",v->v.writeInt(1)));
        check(!CanonicalItemFingerprint.hash(byteValue).equals(CanonicalItemFingerprint.hash(intValue)), "numeric tag types preserved");
        byte[] first=item(out->field(out,9,"list",v->{v.writeByte(3);v.writeInt(2);v.writeInt(1);v.writeInt(2);}));
        byte[] second=item(out->field(out,9,"list",v->{v.writeByte(3);v.writeInt(2);v.writeInt(2);v.writeInt(1);}));
        check(!CanonicalItemFingerprint.hash(first).equals(CanonicalItemFingerprint.hash(second)), "list order preserved");
        check(!CanonicalItemFingerprint.hash(item(out->field(out,9,"empty",v->{v.writeByte(1);v.writeInt(0);}))).equals(CanonicalItemFingerprint.hash(item(out->field(out,9,"empty",v->{v.writeByte(3);v.writeInt(0);})))), "empty list element types preserved");
        check(!CanonicalItemFingerprint.hash(item(out->field(out,11,"array",v->{v.writeInt(1);v.writeInt(1);}))).equals(CanonicalItemFingerprint.hash(item(out->field(out,12,"array",v->{v.writeInt(1);v.writeLong(1);})))), "array types preserved");
        check(!CanonicalItemFingerprint.hash(item(out->field(out,8,"pdc",v->v.writeUTF("original")))).equals(CanonicalItemFingerprint.hash(item(out->field(out,8,"pdc",v->v.writeUTF("changed"))))), "PDC contents preserved");
        for(int type=1;type<=12;type++){
            final int tag=type;
            check(!CanonicalItemFingerprint.hash(item(out->field(out,tag,"value",v->value(v,tag,1)))).equals(CanonicalItemFingerprint.hash(item(out->field(out,tag,"value",v->value(v,tag,2))))),"tag family "+tag+" exact contents preserved");
        }
        refused(Arrays.copyOf(a,a.length-1),"truncated data refused");
        refused(item(out->field(out,7,"array",v->v.writeInt(-1))),"negative length refused");
        refused(item(out->field(out,12,"array",v->v.writeInt(Integer.MAX_VALUE))),"oversized length refused");
        refused(item(out->field(out,10,"deep",v->nested(v,65))),"excessive depth refused");
        if(args.length==2){
            byte[] before=java.nio.file.Files.readAllBytes(java.nio.file.Path.of(args[0])),after=java.nio.file.Files.readAllBytes(java.nio.file.Path.of(args[1]));
            check(!Arrays.equals(before,after),"actual Paper raw snapshots differ after reload");
            check(CanonicalItemFingerprint.hash(before).equals(CanonicalItemFingerprint.hash(after)),"actual legacy Paper snapshots are semantically identical");
        }
        System.out.println("Canonical item fingerprint checks passed");
    }
}
