package org.agentcity.paper;

import net.minecraft.world.level.block.LeverBlock;
import org.bukkit.block.Block;
import org.bukkit.craftbukkit.block.CraftBlock;
import org.bukkit.block.data.Powerable;
import org.bukkit.Bukkit;
import net.minecraft.world.level.block.state.BlockState;

/** Pinned Paper native path: Bukkit data writes omit the lever's support notifications. */
final class NativeLever {
    static void set(Block block,boolean powered) {
        if(!(block.getBlockData() instanceof Powerable state)||block.getType()!=org.bukkit.Material.LEVER)throw new IllegalStateException("input_missing_or_wrong_type");
        if(state.isPowered()==powered)return;
        CraftBlock craft=(CraftBlock)block;
        BlockState nativeState;
        try {
            String accessor=switch(Bukkit.getMinecraftVersion()) {case "1.21.11" -> "getNMS";case "26.3" -> "getBlockState";default -> throw new IllegalStateException("unsupported_native_lever_version");};
            nativeState=(BlockState)CraftBlock.class.getMethod(accessor).invoke(craft);
        } catch(ReflectiveOperationException error) {throw new IllegalStateException("unsupported_native_lever",error);}
        if(!(nativeState.getBlock() instanceof LeverBlock lever))throw new IllegalStateException("unsupported_native_lever");
        lever.pull(nativeState,craft.getCraftWorld().getHandle(),craft.getPosition(),null);
        if(!(((Powerable)block.getBlockData()).isPowered()==powered))throw new IllegalStateException("input_did_not_change");
    }
}
