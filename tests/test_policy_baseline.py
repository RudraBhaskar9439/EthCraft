"""Review policy fixtures and independent boundary oracles, not runtime guards."""

from pathlib import Path
import json
import unittest


ROOT = Path(__file__).resolve().parents[1]
POLICY = json.loads((ROOT / 'config/p0-policy.json').read_text())
AUTHORITY = json.loads((ROOT / 'fixtures/policy/authority.json').read_text())
TRANSITIONS = json.loads((ROOT / 'fixtures/policy/transitions.json').read_text())


def role_allowed(role, action):
    if role not in AUTHORITY['roles']:
        return False
    return any(c['action'] == action and role in c['roles']
               for c in AUTHORITY['capabilities'])


def transition_allowed(origin, target, action, role, established_guards):
    return any(row['from'] == origin and row['to'] == target
               and row['action'] == action and role in row['roles']
               and role_allowed(role, action)
               and set(row['guards']).issubset(established_guards)
               for row in TRANSITIONS['allowed'])


def allocation_oracle(recipients, amounts, limit):
    if not 1 <= len(recipients) <= limit or len(recipients) != len(amounts):
        return False
    if any(not isinstance(r, str) or len(r) != 42 or not r.startswith('0x')
           or any(c not in '0123456789abcdefABCDEF' for c in r[2:])
           or int(r[2:], 16) == 0 for r in recipients):
        return False
    if len({r.lower() for r in recipients}) != len(recipients):
        return False
    return all(type(a) is int and a > 0 for a in amounts) and sum(amounts) < 2 ** 256


class PolicyBaselineTests(unittest.TestCase):
    def test_plot_hazards_and_nonstructural_power_have_explicit_rules(self):
        world=POLICY['world_controls']
        self.assertEqual(world['structural_mutation_during_inspection_or_review'],'deny')
        self.assertFalse(world['natural_redstone_power_changes_are_structural'])
        self.assertEqual(set(world['indirect_hazards_must_be_denied_at_protected_plot']),
                         {'piston_extension','piston_retraction','entity_explosion','block_explosion',
                          'fire_ignite','fire_burn','fire_spread','fluid_flow','falling_block','entity_block_change'})
        manifest=json.loads((ROOT/'fixtures/candidates/redstone-compiler/calculator-candidate-v1.json').read_text())
        for placement in manifest['placements']:
            translated=[v+world['candidate_origin_relative'][i] for i,v in enumerate(placement['position'])]
            self.assertTrue(all(world['plot_relative_min'][i]<=v<=world['plot_relative_max'][i] for i,v in enumerate(translated)))

    def test_fault_schedule_covers_unknown_effects_and_storage_fail_closed(self):
        self.assertEqual(set(POLICY['fault_injection_points']['plugin_mutation']),
                         {'before_durable_intent','after_intent_before_mutation','after_mutation_before_receipt','after_receipt_before_acknowledgement'})
        self.assertIn('after_submission_before_hash_persistence',POLICY['fault_injection_points']['chain'])
        self.assertIn('deep_reorganization_after_delivery',POLICY['fault_injection_points']['chain'])
        limits=POLICY['limits_and_targets']
        self.assertGreater(limits['minimum_free_disk_bytes_before_mutation'],0)
        self.assertTrue(limits['retain_all_unreconciled_receipts'])
        self.assertGreater(limits['p95_game_command_ack_ms_target'],0)
        self.assertGreater(limits['p95_backend_read_ms_target'],0)

    def test_scope_is_local_single_job_and_not_participant_approval(self):
        self.assertEqual(POLICY['status'],
                         'adopted local engineering baseline; participant approval and runtime measurements pending')
        self.assertEqual(POLICY['scope']['active_jobs'], 1)
        self.assertEqual(POLICY['scope']['protected_plots'], 1)
        self.assertEqual(POLICY['scope']['registered_bots'], 1)
        self.assertFalse(POLICY['scope']['team_ui_enabled'])
        self.assertFalse(POLICY['runtime_enforcement_implemented'])
        self.assertFalse(POLICY['runtime_measurements_complete'])
        self.assertFalse(POLICY['participant_agreement_approval_complete'])

    def test_identity_and_delayed_external_requirements_are_explicit(self):
        self.assertTrue(POLICY['identity']['challenge_single_use'])
        self.assertEqual(POLICY['identity']['current_wallets_per_player_server'], 1)
        self.assertEqual(POLICY['identity']['current_players_per_wallet_server'], 1)
        self.assertFalse(POLICY['identity']['relink_changes_existing_funded_parties'])
        self.assertFalse(POLICY['identity']['lost_wallet_recovery_supported'])
        self.assertEqual(set(POLICY['identity']['normal_relink_requires']),
                         {'live_game_session', 'current_wallet_consent', 'replacement_wallet_consent'})
        external = POLICY['external_requirements']
        self.assertTrue(external['independent_human_participants'].startswith('P4 '))
        self.assertTrue(external['token_platform_suitability'].startswith('P5 '))
        self.assertTrue(external['funded_chain_preflight'].startswith('P5 '))
        self.assertFalse(external['local_fixture_identities_prove_independent_humans'])
        self.assertFalse(external['private_or_testnet_implies_platform_exemption'])

    def test_default_deny_and_capability_schema(self):
        self.assertEqual(AUTHORITY['default'], 'deny')
        self.assertEqual(TRANSITIONS['default'], 'deny')
        roles = AUTHORITY['roles']
        self.assertEqual(len(roles), len(set(roles)))
        actions = [c['action'] for c in AUTHORITY['capabilities']]
        self.assertEqual(len(actions), len(set(actions)))
        for c in AUTHORITY['capabilities']:
            self.assertTrue(c['scope'])
            self.assertTrue(c['roles'])
            self.assertTrue(set(c['roles']).issubset(roles))
        for role in roles + ['model', 'unknown']:
            self.assertFalse(role_allowed(role, 'arbitrary_admin_command'))
        for action in actions:
            self.assertFalse(role_allowed('unknown', action))
        for role in ['stranger', 'unauthenticated']:
            allowed = {a for a in actions if role_allowed(role, a)}
            self.assertEqual(allowed, set(AUTHORITY['public_actions']))

    def test_only_requester_accepts_and_services_do_not_escalate(self):
        for role in AUTHORITY['roles']:
            self.assertEqual(role_allowed(role, 'accept_revision'), role == 'requester')
        for action, owner in [('issue_kit', 'issuer'),
                              ('publish_service_state', 'publisher'),
                              ('issue_pass_attestation', 'inspection_attestor')]:
            for role in AUTHORITY['roles']:
                self.assertEqual(role_allowed(role, action), role == owner)
        self.assertFalse(AUTHORITY['requester_acceptance_may_be_delegated_to_model_bot_or_admin'])
        self.assertTrue(AUTHORITY['model_has_no_role_or_key_by_default'])
        services = POLICY['authority']['service_roles_separate']
        self.assertEqual(len(services), 4)
        self.assertEqual(len(set(services)), 4)
        self.assertFalse(POLICY['authority']['service_keys_provisioned'])

    def test_every_mutating_envelope_has_bound_context(self):
        self.assertEqual(set(AUTHORITY['every_mutating_command_requires']),
                         {'operation_id', 'server_id', 'job_id', 'agreement_version',
                          'actor', 'authorization_reference', 'expected_revision',
                          'typed_action_parameters', 'expires_at_ms'})
        self.assertTrue(POLICY['authority']['receiving_boundary_recheck'])
        self.assertFalse(POLICY['authority']['display_names_are_identity'])

    def test_transition_schema_references_declared_roles_actions_guards(self):
        self.assertEqual(len(TRANSITIONS['states']), 14)
        seen = set()
        for row in TRANSITIONS['allowed']:
            key = (row['from'], row['to'], row['action'])
            self.assertNotIn(key, seen)
            seen.add(key)
            self.assertIn(row['from'], TRANSITIONS['states'])
            self.assertIn(row['to'], TRANSITIONS['states'])
            self.assertNotEqual(row['from'], row['to'])
            self.assertTrue(row['guards'])
            self.assertTrue(set(row['guards']).issubset(TRANSITIONS['guards']))
            for role in row['roles']:
                self.assertTrue(role_allowed(role, row['action']))

    def test_all_196_ordered_state_pairs_have_explicit_allow_or_deny(self):
        expected_pairs = {
            ('Draft', 'Open'), ('Draft', 'Cancelled'), ('Open', 'Cancelled'),
            ('Open', 'Agreed'), ('Agreed', 'Funded'), ('Agreed', 'Cancelled'),
            ('Funded', 'Procuring'), ('Procuring', 'DeliveryPending'),
            ('DeliveryPending', 'Building'), ('Building', 'Inspecting'),
            ('Inspecting', 'RepairRequired'), ('Inspecting', 'Building'),
            ('RepairRequired', 'Building'), ('Inspecting', 'ReadyForReview'),
            ('ReadyForReview', 'Accepted'), ('Accepted', 'Paid'),
            *{(s, 'Refunded') for s in ['Funded', 'Procuring', 'DeliveryPending',
                                       'Building', 'Inspecting', 'RepairRequired', 'ReadyForReview']}
        }
        actual_pairs = {(r['from'], r['to']) for r in TRANSITIONS['allowed']}
        self.assertEqual(actual_pairs, expected_pairs)
        self.assertEqual(len(actual_pairs), 23)
        checked = 0
        for origin in TRANSITIONS['states']:
            for target in TRANSITIONS['states']:
                checked += 1
                if (origin, target) not in expected_pairs:
                    for row in TRANSITIONS['allowed']:
                        for role in row['roles']:
                            self.assertFalse(transition_allowed(origin, target, row['action'],
                                                                role, set(TRANSITIONS['guards'])))
        self.assertEqual(checked, 196)
        self.assertTrue(TRANSITIONS['all_other_state_pairs_denied'])

    def test_every_transition_needs_every_guard_and_correct_actor(self):
        for row in TRANSITIONS['allowed']:
            role = row['roles'][0]
            args = (row['from'], row['to'], row['action'])
            guards = set(row['guards'])
            self.assertTrue(transition_allowed(*args, role, guards))
            for missing in guards:
                self.assertFalse(transition_allowed(*args, role, guards - {missing}))
            self.assertFalse(transition_allowed(*args, 'unauthenticated', guards))
            self.assertFalse(transition_allowed(*args, 'model', guards))

    def test_pass_acceptance_refund_and_terminal_rules(self):
        for row in TRANSITIONS['allowed']:
            if row['to'] == 'ReadyForReview':
                self.assertEqual(row['roles'], ['inspection_attestor'])
                self.assertTrue({'complete_16_case_pass', 'protected_matching_agreement_revision',
                                 'before_work_deadline'}.issubset(row['guards']))
            if row['to'] == 'Accepted':
                self.assertEqual(row['roles'], ['requester'])
                self.assertIn('valid_pass_review_and_escrow_time', row['guards'])
                self.assertIn('canonical_requester_acceptance', row['guards'])
            if row['to'] == 'Refunded':
                self.assertIn('absolute_expiry_reached', row['guards'])
                self.assertIn('escrow_unaccepted', row['guards'])
                self.assertNotIn(row['from'], ['Accepted', 'Paid'])
            self.assertNotIn(row['from'], TRANSITIONS['terminal_job_states'])
        self.assertTrue(TRANSITIONS['waiting_reasons_are_substates'])
        self.assertTrue(TRANSITIONS['cancelled_or_refunded_material_obligations_survive'])

    def test_half_open_expiry_in_both_declared_clock_units(self):
        self.assertEqual(POLICY['expiry']['validity_comparison'], 'authority_now < expires_at')
        self.assertEqual(POLICY['expiry']['refund_comparison'], 'chain_timestamp >= absolute_expiry')
        for expiry in [1_000_000, 1_000_000_000]:
            self.assertTrue(expiry - 1 < expiry)
            self.assertFalse(expiry < expiry)
            self.assertFalse(expiry + 1 < expiry)
            self.assertFalse(expiry - 1 >= expiry)
            self.assertTrue(expiry >= expiry)
            self.assertTrue(expiry + 1 >= expiry)
        self.assertIn('seconds', POLICY['expiry']['chain_unit'])
        self.assertIn('milliseconds', POLICY['expiry']['backend_game_unit'])
        self.assertFalse(POLICY['expiry']['client_clock_is_authority'])

    def test_fixed_schedule_never_resets_from_confirmation_or_resubmission(self):
        start = 1_000_000
        work = start + POLICY['expiry']['work_seconds_after_fixed_approved_start_epoch']
        review = work + POLICY['expiry']['review_seconds_after_fixed_work_deadline']
        expiry = review
        self.assertLess(start, work)
        self.assertLess(work, review)
        self.assertEqual(review, expiry)
        self.assertTrue(work - 1 < work)
        self.assertFalse(work < work)
        self.assertFalse(work + 1 < work)
        self.assertTrue(work + 1 < min(review, expiry))
        self.assertFalse(review < min(review, expiry))
        self.assertFalse(POLICY['expiry']['resubmission_extends_deadlines'])
        self.assertFalse(POLICY['expiry']['outage_extends_deadlines'])
        self.assertTrue(POLICY['expiry']['passing_report_requires_completion_before_work_deadline'])
        self.assertIn('approved before signatures and funding', POLICY['expiry']['schedule_anchor'])

    def test_one_current_fenced_lease_and_bounded_retries(self):
        lease = POLICY['leases']
        self.assertEqual(lease['max_conflicting_executable_leases'], 1)
        self.assertTrue(lease['fencing_revision_required'])
        self.assertTrue(lease['recheck_at_execution'])
        self.assertFalse(lease['expired_worker_may_mutate'])
        expiry = POLICY['expiry']
        self.assertGreater(expiry['task_lease_seconds'], expiry['lease_renewal_seconds'])
        limits = POLICY['limits_and_targets']
        self.assertEqual(limits['safe_retry_total_attempts'], 3)
        self.assertEqual(limits['retry_delays_seconds'], [1, 2])
        self.assertFalse(limits['retry_unknown_side_effect'])

    def test_no_early_unlock_or_self_certified_pass(self):
        lock = POLICY['locks']
        self.assertTrue(lock['persist_before_inspection'])
        self.assertFalse(lock['default_early_unlock'])
        self.assertFalse(lock['new_pass_or_repair_while_pass_usable'])
        self.assertTrue(lock['retain_while_any_pass_usable'])
        self.assertTrue(lock['retain_during_unknown_acceptance'])
        self.assertTrue(lock['review_input_toggles_allowed'])
        self.assertFalse(lock['inspection_external_input_toggles_allowed'])
        self.assertFalse(lock['release_after_finalized_acceptance_waits_for_reward_withdrawal'])
        self.assertTrue(lock['release_requires_canonical_settlement_or_no_usable_pass_and_no_unknown_acceptance'])
        for role in ['bot', 'builder', 'server_operator', 'publisher', 'issuer', 'model']:
            self.assertFalse(role_allowed(role, 'issue_pass_attestation'))

    def test_whole_kit_units_and_fractional_liability_are_not_conflated(self):
        scale = 10 ** POLICY['tokens']['kit_decimals_proposed']
        def whole_kit(units):
            return type(units) is int and units > 0 and units % scale == 0
        for units in [scale, 2 * scale, 10 * scale]:
            self.assertTrue(whole_kit(units))
        for units in [0, -scale, scale // 2, scale + 1, 1.5, True]:
            self.assertFalse(whole_kit(units))
        self.assertTrue(POLICY['tokens']['issuance_whole_kit_only'])
        self.assertTrue(POLICY['tokens']['redemption_whole_kit_only'])
        self.assertTrue(POLICY['tokens']['fractional_transfer_liabilities_retained'])
        # Two fractional holders still owe one full bundle; never truncate each holder.
        halves = [scale // 2, scale // 2]
        ingredient_per_kit = 3
        self.assertEqual(sum(halves), scale)
        self.assertTrue(3 * scale >= ingredient_per_kit * sum(halves))
        self.assertFalse(2 * scale >= ingredient_per_kit * sum(halves))

    def test_burn_and_pool_transfers_preserve_itemwise_obligations(self):
        scale = 10 ** POLICY['tokens']['kit_decimals_proposed']
        ingredient_per_kit = 19
        initial_liability = ingredient_per_kit * (10 * scale)
        after_two_pending_burns = ingredient_per_kit * (8 * scale + 2 * scale)
        self.assertEqual(initial_liability, after_two_pending_burns)
        self.assertTrue(190 * scale >= after_two_pending_burns)
        self.assertFalse(189 * scale >= after_two_pending_burns)
        holders = {'wallets': 2 * scale, 'pool': 8 * scale}
        self.assertEqual(sum(holders.values()), 10 * scale)
        self.assertNotEqual(sum(holders.values()) + holders['pool'], 10 * scale)
        self.assertTrue(POLICY['tokens']['circulating_supply_includes_pool_holdings_once'])
        self.assertFalse(POLICY['tokens']['actual_balances_or_minting_established'])

    def test_one_builder_ui_and_up_to_eight_fixed_contract_allocations(self):
        a = POLICY['allocations']
        self.assertEqual(a['minimum_contract_recipients'], 1)
        self.assertEqual(a['maximum_contract_recipients'], 8)
        self.assertEqual(a['maximum_ui_recipients'], 1)
        for count in range(1, 9):
            recipients = [f'0x{i + 1:040x}' for i in range(count)]
            self.assertTrue(allocation_oracle(recipients, [1] * count, a['maximum_contract_recipients']))
            self.assertEqual(allocation_oracle(recipients, [1] * count, a['maximum_ui_recipients']), count == 1)
        valid = ['0x' + '1' * 40]
        invalid = [([], []), (['0x' + '0' * 40], [1]),
                   (valid * 2, [1, 2]), (valid, [0]), (valid, [-1]),
                   (valid, [True]), (valid, [1.5]), (valid, [2 ** 256]),
                   (valid, []), ([f'0x{i + 1:040x}' for i in range(9)], [1] * 9)]
        for recipients, amounts in invalid:
            self.assertFalse(allocation_oracle(recipients, amounts, a['maximum_contract_recipients']))
        self.assertTrue(a['exact_funding_only'])
        self.assertFalse(a['funded_terms_mutable'])
        self.assertTrue(a['claim_pays_immutable_recipient'])

    def test_ownership_and_timeout_do_not_erase_other_assets(self):
        self.assertFalse(POLICY['ownership']['refund_reverses_material_purchase_or_delivery_claim'])
        self.assertTrue(POLICY['ownership']['termination_revokes_builder_work_access'])
        self.assertTrue(POLICY['ownership']['unused_stock_return_requires_audited_operation'])
        self.assertTrue(POLICY['settlement']['accepted_late_claims_remain_entitlements'])
        self.assertFalse(POLICY['settlement']['funded_early_cancellation_supported_initially'])
        self.assertTrue(POLICY['settlement']['requester_refusal_can_leave_builder_unpaid'])
        self.assertFalse(POLICY['settlement']['arbitration_or_partial_payment_supported'])

    def test_finality_and_deep_reorganization_policy_fail_closed(self):
        s = POLICY['settlement']
        self.assertEqual(s['confirmation_count'], 12)
        self.assertTrue(s['require_finalized_block_covering_source_event'])
        self.assertIsNone(s['selected_network'])
        for count in [11, 12, 13]:
            for finalized in [None, False, True]:
                eligible = count >= s['confirmation_count'] and finalized is True
                self.assertEqual(eligible, count >= 12 and finalized is True)
        self.assertIn('block irreversible delivery', s['unsupported_or_uncertain_finality'])
        self.assertFalse(s['automatic_physical_replay_or_clawback'])
        self.assertTrue(s['remediation_requires_explicit_authority'])
        self.assertFalse(s['automatic_compensation_or_replacement_funding_promised'])
        self.assertFalse(s['authority_granted_by_fixture_identifiers'])

    def test_limits_are_coherent_targets_and_not_fake_measurements(self):
        l = POLICY['limits_and_targets']
        self.assertFalse(l['values_are_measured_results'])
        for name in ['max_game_interactions_per_second', 'max_placements_per_stage',
                     'max_queued_commands', 'max_command_utf8_bytes', 'normal_tps_target',
                     'coordinated_snapshot_seconds_target', 'restore_seconds_target']:
            self.assertIs(type(l[name]), int)
            self.assertGreater(l[name], 0)
        self.assertEqual(l['lost_acknowledged_obligations_target'], 0)
        self.assertFalse(l['network_or_database_wait_on_game_thread_allowed'])
        self.assertLess(l['inspection_case_wall_seconds_ceiling_candidate'], l['inspection_run_wall_seconds_ceiling_candidate'])
        self.assertLess(l['coordinated_snapshot_seconds_target'], l['restore_seconds_target'])
        self.assertFalse(POLICY['research']['research_favorable_result_required'])
        self.assertTrue(POLICY['research']['retain_failed_null_negative_results'])
        self.assertTrue(POLICY['research']['actual_users_required_for_comprehension'])


if __name__ == '__main__':
    unittest.main()
