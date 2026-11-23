import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser } from '../../common/auth';
import { type ErrorCode, Operation } from '../../common/errors';
import { ApiContract } from '../../openapi/api-contract.decorator';
import { invalidRequest, isPostgresUuidInput } from '../incidents/incident-input';
import { ALLERGIES, MEDICAL_CONDITIONS } from './medical-items';
import {
  medicalItemParamsSchema,
  medicalItemRequestSchema,
  profileSchema,
} from './profile.schemas';
import type { ProfileJson } from './profiles.repository';
import { ProfilesService } from './profiles.service';

/** The `{item_id}` path parameter: valid uuid input, else 422 on field `item_id`. */
function requireItemId(value: unknown): string {
  if (!isPostgresUuidInput(value)) throw invalidRequest('item_id');
  return value;
}

const PROFILE_RESPONSE = {
  description:
    'The full Profile after the change (as `GET /v1/me/profile`): `allergy_items` / `medical_condition_items` (oldest first) and `medical_info_updated_at` (now). The old text field is the items joined with ", ".',
  name: 'Profile',
  schema: profileSchema,
};

const LIVE_VIEW =
  ' During an active incident the live incident view is updated and `incident.shared_info_updated` is sent to the incident room (D53); what the alerts carried at activation never changes.';

const ADD_ERRORS: readonly ErrorCode[] = [
  'validation:invalid_request',
  'profiles:invalid_medical_item',
  'profiles:profile_not_found',
  'profiles:medical_item_limit_reached',
  'profiles:duplicate_medical_item',
];

const EDIT_ERRORS: readonly ErrorCode[] = [
  'validation:invalid_request',
  'profiles:invalid_medical_item',
  'profiles:profile_not_found',
  'profiles:duplicate_medical_item',
  'profiles:medical_item_not_found',
];

const DELETE_ERRORS: readonly ErrorCode[] = [
  'validation:invalid_request',
  'profiles:profile_not_found',
  'profiles:medical_item_not_found',
];

/**
 * SCRUM-21 (D51): the caller's allergies and medical conditions, each item added, edited and deleted
 * on its own. Only the caller's own items (`profile.self`): an id of another user's item, or of the
 * other list, is 404 `profiles:medical_item_not_found`, as an unknown one. Default authenticated
 * rate limit; no Idempotency-Key (a repeated add answers `duplicate_medical_item`, a repeated delete
 * `medical_item_not_found`).
 */
@Controller('me/profile')
export class MeMedicalItemsController {
  constructor(private readonly profiles: ProfilesService) {}

  @Post('allergies')
  @HttpCode(200)
  @Operation('profiles')
  @ApiContract({
    operationId: 'addAllergy',
    summary: 'Add an allergy',
    tag: 'profiles',
    body: { name: 'MedicalItemRequest', schema: medicalItemRequestSchema },
    responses: {
      200: { ...PROFILE_RESPONSE, description: PROFILE_RESPONSE.description + LIVE_VIEW },
    },
    errors: ADD_ERRORS,
  })
  addAllergy(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown): Promise<ProfileJson> {
    return this.profiles.addMedicalItem(user, ALLERGIES, body);
  }

  @Patch('allergies/:item_id')
  @Operation('profiles')
  @ApiContract({
    operationId: 'editAllergy',
    summary: 'Change the text of one allergy',
    tag: 'profiles',
    params: medicalItemParamsSchema,
    body: { name: 'MedicalItemRequest', schema: medicalItemRequestSchema },
    responses: {
      200: { ...PROFILE_RESPONSE, description: PROFILE_RESPONSE.description + LIVE_VIEW },
    },
    errors: EDIT_ERRORS,
  })
  editAllergy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('item_id') itemId: unknown,
    @Body() body: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.editMedicalItem(user, ALLERGIES, requireItemId(itemId), body);
  }

  @Delete('allergies/:item_id')
  @Operation('profiles')
  @ApiContract({
    operationId: 'deleteAllergy',
    summary: 'Delete one allergy',
    tag: 'profiles',
    params: medicalItemParamsSchema,
    responses: {
      200: { ...PROFILE_RESPONSE, description: PROFILE_RESPONSE.description + LIVE_VIEW },
    },
    errors: DELETE_ERRORS,
  })
  deleteAllergy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('item_id') itemId: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.deleteMedicalItem(user, ALLERGIES, requireItemId(itemId));
  }

  @Post('medical-conditions')
  @HttpCode(200)
  @Operation('profiles')
  @ApiContract({
    operationId: 'addMedicalCondition',
    summary: 'Add a medical condition',
    tag: 'profiles',
    body: { name: 'MedicalItemRequest', schema: medicalItemRequestSchema },
    responses: {
      200: { ...PROFILE_RESPONSE, description: PROFILE_RESPONSE.description + LIVE_VIEW },
    },
    errors: ADD_ERRORS,
  })
  addMedicalCondition(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.addMedicalItem(user, MEDICAL_CONDITIONS, body);
  }

  @Patch('medical-conditions/:item_id')
  @Operation('profiles')
  @ApiContract({
    operationId: 'editMedicalCondition',
    summary: 'Change the text of one medical condition',
    tag: 'profiles',
    params: medicalItemParamsSchema,
    body: { name: 'MedicalItemRequest', schema: medicalItemRequestSchema },
    responses: {
      200: { ...PROFILE_RESPONSE, description: PROFILE_RESPONSE.description + LIVE_VIEW },
    },
    errors: EDIT_ERRORS,
  })
  editMedicalCondition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('item_id') itemId: unknown,
    @Body() body: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.editMedicalItem(user, MEDICAL_CONDITIONS, requireItemId(itemId), body);
  }

  @Delete('medical-conditions/:item_id')
  @Operation('profiles')
  @ApiContract({
    operationId: 'deleteMedicalCondition',
    summary: 'Delete one medical condition',
    tag: 'profiles',
    params: medicalItemParamsSchema,
    responses: {
      200: { ...PROFILE_RESPONSE, description: PROFILE_RESPONSE.description + LIVE_VIEW },
    },
    errors: DELETE_ERRORS,
  })
  deleteMedicalCondition(
    @CurrentUser() user: AuthenticatedUser,
    @Param('item_id') itemId: unknown,
  ): Promise<ProfileJson> {
    return this.profiles.deleteMedicalItem(user, MEDICAL_CONDITIONS, requireItemId(itemId));
  }
}
